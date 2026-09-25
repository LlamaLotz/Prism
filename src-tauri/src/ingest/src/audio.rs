use crate::{Error, Result};
use std::path::Path;
#[cfg(not(feature = "ml"))]
pub fn extract(_: &Path, _: &Path) -> Result<String> {
    Err(Error::new("unavailable", "Whisper support not compiled"))
}
/// Only accept complete segments not already emitted in the preceding overlapping window.
pub fn new_segment(window_start_cs: i64, end_cs: i64, emitted_until_cs: i64) -> bool {
    window_start_cs + end_cs > emitted_until_cs
}
#[cfg(feature = "ml")]
pub fn extract(path: &Path, scratch: &Path) -> Result<String> {
    use std::{
        io::{Read, Seek, SeekFrom},
        process::Command,
        time::Duration,
    };
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
    let gpu = cfg!(any(feature = "metal", feature = "cuda"));
    let load = |gpu: bool| -> Result<WhisperContext> {
        let model = crate::assets::model(if gpu {
            "ggml-small.bin"
        } else {
            "ggml-small-q8_0.bin"
        })?;
        let mut config = WhisperContextParameters::default();
        config.use_gpu(gpu);
        WhisperContext::new_with_params(&model, config).map_err(|e| Error::new("unavailable", e))
    };
    let ctx = if gpu {
        load(true).or_else(|_| {
            crate::event("diagnostic", "GPU unavailable; retrying CPU Whisper");
            load(false)
        })?
    } else {
        load(false)?
    };
    let mut state = ctx.create_state().map_err(|e| Error::new("extract", e))?;
    let pcm = scratch.join("audio.pcm");
    crate::process::run(
        Command::new(crate::process::binary("ffmpeg"))
            .args([
                "-nostdin",
                "-v",
                "error",
                "-threads",
                &crate::budget().to_string(),
                "-i",
            ])
            .arg(path)
            .args(["-vn", "-ar", "16000", "-ac", "1", "-f", "f32le", "-y"])
            .arg(&pcm),
        Duration::from_secs(7200),
        1024 * 1024,
    )?;
    let mut file = std::fs::File::open(pcm)?;
    let total = file.metadata()?.len() / 4;
    let mut offset = 0u64;
    let mut output = String::new();
    let mut emitted = 0i64;
    let mut language: Option<String> = None;
    let vad = crate::assets::model("ggml-silero-v5.1.2.bin").ok();
    while offset < total {
        file.seek(SeekFrom::Start(offset * 4))?;
        let mut bytes = vec![0; ((total - offset).min(30 * 16000) * 4) as usize];
        file.read_exact(&mut bytes)?;
        let samples = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect::<Vec<_>>();
        let mut success = false;
        for use_vad in [true, false] {
            if use_vad && vad.is_none() {
                continue;
            }
            let mut params = FullParams::new(SamplingStrategy::BeamSearch {
                beam_size: 1,
                patience: -1.0,
            });
            params.set_n_threads(crate::budget() as i32);
            params.set_token_timestamps(true);
            params.set_print_special(false);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            params.set_language(language.as_deref());
            params.set_initial_prompt(
                &output
                    .chars()
                    .rev()
                    .take(600)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>(),
            );
            if use_vad {
                params.set_vad_model_path(Some(&vad.as_ref().unwrap().to_string_lossy()));
                params.enable_vad(true);
            }
            match state.full(params, &samples) {
                Ok(()) if state.full_n_segments() > 0 => {
                    success = true;
                    break;
                }
                Ok(_) => {}
                Err(_) if use_vad => {}
                Err(e) => return Err(Error::new("extract", e)),
            }
        }
        if success {
            if language.is_none() {
                language =
                    whisper_rs::get_lang_str(state.full_lang_id_from_state()).map(str::to_owned);
            }
            let boundary = emitted;
            for segment in state.as_iter() {
                if !new_segment((offset / 160) as i64, segment.end_timestamp(), boundary) {
                    continue;
                }
                if offset > 0 && (offset / 160) as i64 + segment.start_timestamp() < boundary {
                    for i in 0..segment.n_tokens() {
                        let token = segment.get_token(i).unwrap();
                        let data = token.token_data();
                        if data.t1 >= 0 && (offset / 160) as i64 + data.t1 > boundary {
                            let text = token.to_string();
                            if !text.starts_with("[_") && !text.starts_with("<|") {
                                output.push_str(&text);
                            }
                        }
                    }
                    output.push(' ');
                } else {
                    output.push_str(segment.to_string().trim());
                    output.push(' ');
                }
                emitted = emitted.max((offset / 160) as i64 + segment.end_timestamp());
            }
        }
        crate::event(
            "progress",
            format!(
                "{}/{} Audio seconds",
                (offset + samples.len() as u64) / 16000,
                total / 16000
            ),
        );
        if offset + samples.len() as u64 >= total {
            break;
        }
        offset += 29 * 16000;
    }
    if output.trim().is_empty() {
        Err(Error::new("quality", "Whisper produced no speech"))
    } else {
        Ok(output.trim().into())
    }
}

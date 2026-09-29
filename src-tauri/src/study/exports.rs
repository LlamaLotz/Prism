use super::*;
use std::process::{Command,Stdio};
#[tauri::command]
pub async fn study_export(app:tauri::AppHandle,vault_path:String,id:String,format:String)->Result<bool,String>{
 let s=scope(&app,&vault_path)?;
 tauri::async_runtime::spawn_blocking(move||{
  let c=db(&s)?;let a=artifacts::get(&c,&id)?;
  let allowed=match a.kind.as_str(){"table"=>vec!["csv","pdf"],"quiz"=>vec!["md","pdf"],"flashcards"=>vec!["csv","apkg","pdf"],"podcast"=>vec!["mp3","md","pdf"],"slides"=>vec!["pptx","pdf"],"mindmap"=>vec!["svg","md","pdf"],_=>vec![]};
  if !allowed.contains(&format.as_str()){return Err("Unsupported export format".into());}
  let snapshot=load_snapshot(&c,&a.snapshot_id)?;    let temp=tempfile::tempdir().map_err(error)?;let output=temp.path().join(format!("export.{format}"));
  if format=="mp3" {
    let audio=s.root.join(".prism/study/media").join(format!("{}.mp3",a.id));operations::validate(&s.root,&audio)?;
    if !audio.is_file(){return Err("Generate and save the podcast audio first".into());}std::fs::copy(audio,&output).map_err(error)?;
  }else{
    let root=crate::notebook::runtime_root(&app)?;
    let manifest:Value=serde_json::from_slice(&std::fs::read(root.join("manifest.json")).map_err(error)?).map_err(error)?;
    let python=root.join(manifest["pythonExecutable"].as_str().ok_or("Notebook runtime manifest is incomplete")?);
    let script=temp.path().join("export.py");std::fs::write(&script,include_str!("../../../notebook/study_export.py")).map_err(error)?;
    let input=temp.path().join("input.json");std::fs::write(&input,json!({"artifact":a,"snapshot":snapshot}).to_string()).map_err(error)?;
    let log=std::fs::File::create(temp.path().join("error.log")).map_err(error)?;
    let mut process=Command::new(python).arg("-B").arg(script).arg(&input).arg(&output).env("PYTHONPATH",root.join("lib")).env("PYTHONNOUSERSITE","1").stdout(Stdio::null()).stderr(log).spawn().map_err(error)?;
    let start=std::time::Instant::now();loop{if let Some(status)=process.try_wait().map_err(error)?{if !status.success(){let detail=std::fs::read_to_string(temp.path().join("error.log")).unwrap_or_default();return Err(format!("Export failed. Ensure the bundled study export dependencies are installed. {}",detail.chars().take(1000).collect::<String>()));}break;}if check(&app,&s).is_err()||start.elapsed().as_secs()>60{let _=process.kill();let _=process.wait();return Err("Export cancelled or timed out; the saved material is unchanged".into());}std::thread::sleep(std::time::Duration::from_millis(100));}
  }
  check(&app,&s)?;let name:String=a.title.chars().filter(|ch|!['/','\\',':','\0'].contains(ch)).take(100).collect();
  let Some(destination)=rfd::FileDialog::new().set_file_name(format!("{name}.{format}")).add_filter("Study export",&[format.as_str()]).save_file()else{return Ok(false)};
  check(&app,&s)?;let bytes=std::fs::read(output).map_err(error)?;let parent=destination.parent().ok_or("Invalid export destination")?;let mut staged=tempfile::NamedTempFile::new_in(parent).map_err(error)?;use std::io::Write;staged.write_all(&bytes).map_err(error)?;staged.as_file().sync_all().map_err(error)?;staged.persist(&destination).map_err(error)?;Ok(true)
 }).await.map_err(error)?
}

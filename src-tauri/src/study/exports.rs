use super::*;
#[tauri::command]
pub async fn study_export(app:tauri::AppHandle,vault_path:String,id:String,format:String)->Result<bool,String>{
 let s=scope(&app,&vault_path)?;
 tauri::async_runtime::spawn_blocking(move||{
  let c=db(&s)?;let a=artifacts::get(&c,&id)?;
  let allowed=match a.kind.as_str(){"table"=>vec!["csv","pdf"],"quiz"=>vec!["md","pdf"],"flashcards"=>vec!["csv","apkg","pdf"],"podcast"=>vec!["mp3","md","pdf"],"slides"=>vec!["pptx","pdf"],"mindmap"=>vec!["svg","md","pdf"],_=>vec![]};
  if !allowed.contains(&format.as_str()){return Err("Unsupported export format".into());}
  let temp=tempfile::tempdir().map_err(error)?;let output=temp.path().join(format!("export.{format}"));
  if format=="mp3" {
    let audio=s.root.join(".prism/study/media").join(format!("{}.mp3",a.id));operations::validate(&s.root,&audio)?;
    if !audio.is_file(){return Err("Generate and save the podcast audio first".into());}std::fs::copy(audio,&output).map_err(error)?;
  }else{
    return Err("Export for this format needs the Notebook runtime that shipped with the retired Advanced Notebook. It is no longer bundled, so the saved material is unchanged. Podcast audio (mp3) still exports.".into());
  }
  check(&app,&s)?;let name:String=a.title.chars().filter(|ch|!['/','\\',':','\0'].contains(ch)).take(100).collect();
  let Some(destination)=rfd::FileDialog::new().set_file_name(format!("{name}.{format}")).add_filter("Study export",&[format.as_str()]).save_file()else{return Ok(false)};
  check(&app,&s)?;let bytes=std::fs::read(output).map_err(error)?;let parent=destination.parent().ok_or("Invalid export destination")?;let mut staged=tempfile::NamedTempFile::new_in(parent).map_err(error)?;use std::io::Write;staged.write_all(&bytes).map_err(error)?;staged.as_file().sync_all().map_err(error)?;staged.persist(&destination).map_err(error)?;Ok(true)
 }).await.map_err(error)?
}

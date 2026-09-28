//! Bounded UTF-8 IPC for editor files. Publication uses the durable mutation journal.
use super::{operations, Scope};
use serde::Serialize;
use std::{collections::HashMap, fs::{File, OpenOptions}, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, sync::{Mutex, OnceLock}, time::{Duration, Instant}};
pub const MAX_NOTE_BYTES: u64 = 50 * 1024 * 1024;
const CHUNK: usize = 256 * 1024;
#[derive(Serialize, Debug)]
#[serde(rename_all="camelCase")]
pub struct NoteChunk { text: String, revision: String, next_offset: Option<u64>, bytes: u64 }
pub fn revision(path: &Path) -> Result<String, String> {
    let metadata=std::fs::symlink_metadata(path).map_err(|e|e.to_string())?;
    if !metadata.is_file()||metadata.file_type().is_symlink(){return Err("Unsupported note file".into());}
    if metadata.len()>MAX_NOTE_BYTES{return Err("NOTE_TOO_LARGE: Notes above 50 MiB must be opened in an external editor.".into());}
    #[cfg(unix)] let identity={use std::os::unix::fs::MetadataExt;format!("{}:{}:{}:{}",metadata.dev(),metadata.ino(),metadata.ctime(),metadata.ctime_nsec())};
    #[cfg(not(unix))] let identity=format!("{:?}",metadata.created());
    Ok(format!("{}:{:?}:{identity}",metadata.len(),metadata.modified().map_err(|e|e.to_string())?))
}
fn check(scope:&Scope,path:&Path,expected:&str)->Result<(),String>{operations::validate(&scope.root,path)?;if revision(path)?!=expected{return Err("CONFLICT: Note changed externally. Reload before saving.".into());}Ok(())}
#[tauri::command]
pub fn read_note_chunk(app:tauri::AppHandle,path:String,offset:u64,expected_revision:Option<String>)->Result<NoteChunk,String>{read_chunk(&super::current(&app)?,&path,offset,expected_revision)}
fn read_chunk(scope:&Scope,path:&str,offset:u64,expected_revision:Option<String>)->Result<NoteChunk,String>{
    let path=Path::new(path);operations::validate(&scope.root,path)?;let rev=revision(path)?;
    if expected_revision.as_ref().is_some_and(|e|e!=&rev){return Err("CONFLICT: Note changed while reading".into());}
    let mut file=File::open(path).map_err(|e|e.to_string())?;let bytes=file.metadata().map_err(|e|e.to_string())?.len();if offset>bytes{return Err("Invalid note offset".into());}
    file.seek(SeekFrom::Start(offset)).map_err(|e|e.to_string())?;let mut buffer=vec![0;CHUNK.min((bytes-offset) as usize)];file.read_exact(&mut buffer).map_err(|e|e.to_string())?;
    let length=match std::str::from_utf8(&buffer){Ok(_)=>buffer.len(),Err(e) if e.error_len().is_none()&&offset+(buffer.len() as u64)<bytes=>e.valid_up_to(),Err(_)=>return Err("Note must contain valid UTF-8 text".into())};
    let text=String::from_utf8(buffer[..length].to_vec()).map_err(|e|e.to_string())?;check(scope,path,&rev)?;let next=offset+length as u64;
    Ok(NoteChunk{text,revision:rev,next_offset:(next<bytes).then_some(next),bytes})
}
struct Upload{scope:Scope,path:String,revision:String,staging:PathBuf,bytes:u64,created:Instant}
static UPLOADS:OnceLock<Mutex<HashMap<String,Upload>>>=OnceLock::new();
struct UploadRevisionGuard{id:String}
impl Drop for UploadRevisionGuard{fn drop(&mut self){if let Some(all)=UPLOADS.get(){if let Ok(mut uploads)=all.lock(){uploads.remove(&self.id);}}}}
fn uploads()->&'static Mutex<HashMap<String,Upload>>{UPLOADS.get_or_init(Default::default)}
#[tauri::command]
pub fn begin_note_save(app:tauri::AppHandle,path:String,expected_revision:String)->Result<String,String>{
    let scope=super::current(&app)?;check(&scope,Path::new(&path),&expected_revision)?;let mut all=uploads().lock().map_err(|_|"Save queue unavailable")?;all.retain(|_,u|u.created.elapsed()<Duration::from_secs(600));if all.len()>=4{return Err("Save queue busy. Retry shortly.".into());}
    let id=uuid::Uuid::new_v4().to_string();let staging=scope.root.join(".prism/recovery/uploads").join(&id);operations::validate(&scope.root,&staging)?;std::fs::create_dir_all(staging.parent().unwrap()).map_err(|e|e.to_string())?;OpenOptions::new().create_new(true).write(true).open(&staging).map_err(|e|e.to_string())?;
    all.insert(id.clone(),Upload{scope,path,revision:expected_revision,staging,bytes:0,created:Instant::now()});Ok(id)
}
#[tauri::command]
pub fn append_note_save(app:tauri::AppHandle,id:String,offset:u64,text:String)->Result<(),String>{
    let scope=super::current(&app)?;let mut all=uploads().lock().map_err(|_|"Save queue unavailable")?;let upload=all.get_mut(&id).ok_or("Save expired")?;
    if upload.scope.generation!=scope.generation||offset!=upload.bytes{return Err("CONFLICT: Save no longer current".into());}if text.len()>CHUNK||upload.bytes+text.len() as u64>MAX_NOTE_BYTES{return Err("NOTE_TOO_LARGE: Save exceeds its size limit".into());}
    operations::validate(&scope.root,&upload.staging)?;let mut f=OpenOptions::new().append(true).open(&upload.staging).map_err(|e|e.to_string())?;f.write_all(text.as_bytes()).map_err(|e|e.to_string())?;upload.bytes+=text.len() as u64;Ok(())
}
#[tauri::command]
pub async fn finish_note_save(app:tauri::AppHandle,id:String)->Result<String,String>{
    tauri::async_runtime::spawn_blocking(move||{
        let upload=uploads().lock().map_err(|_|"Save queue unavailable")?.remove(&id).ok_or("Save expired")?;let _guard=operations::lock()?;let scope=super::current(&app)?;let _upload_revision_guard=UploadRevisionGuard{id:id.clone()};
        if upload.scope.generation!=scope.generation{return Err("CONFLICT: Vault changed".into());}check(&scope,Path::new(&upload.path),&upload.revision)?;operations::validate(&scope.root,&upload.staging)?;
        let staged=std::fs::File::open(&upload.staging).map_err(|e|e.to_string())?;staged.sync_all().map_err(|e|e.to_string())?;let size=staged.metadata().map_err(|e|e.to_string())?.len();
        if size!=upload.bytes||size>MAX_NOTE_BYTES{return Err("CONFLICT: Staged save changed".into());}
        let conn=crate::db::init_db(&app)?;let mutation=operations::capture_file(&conn,&scope,"edit_note",&upload.path,None,&upload.staging,&upload.revision)?;
        let operation=operations::apply(&conn,&scope,&mutation)?;
        super::emit(&app,&conn,&scope.vault_id,"note_changed",&upload.path).map_err(|e|format!("PERSISTENCE: Save applied as {operation}, but event publication failed: {e}"))?;
        if upload.staging.exists(){operations::validate(&scope.root,&upload.staging)?;std::fs::remove_file(&upload.staging).map_err(|e|format!("PERSISTENCE: Save applied, but upload cleanup failed: {e}"))?;}
        revision(Path::new(&upload.path))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub fn cancel_note_save(app:tauri::AppHandle,id:String)->Result<(),String>{let scope=super::current(&app)?;let mut all=uploads().lock().map_err(|_|"Save queue unavailable")?;if all.get(&id).is_some_and(|u|u.scope.generation==scope.generation){if let Some(u)=all.remove(&id){operations::validate(&scope.root,&u.staging)?;std::fs::remove_file(u.staging).map_err(|e|e.to_string())?;}}Ok(())}
#[cfg(test)]
mod tests{
 use super::*;
 fn scope(root:&Path)->Scope{Scope{root:root.to_path_buf(),vault_id:"test".into(),generation:"test".into()}}
 #[test]fn chunk_boundaries_preserve_unicode_and_reject_external_changes(){let d=tempfile::tempdir().unwrap();let p=d.path().join("n.md");let original=format!("{}🦀日本étail","x".repeat(CHUNK-1));std::fs::write(&p,&original).unwrap();let s=scope(d.path());let first=read_chunk(&s,p.to_str().unwrap(),0,None).unwrap();let second=read_chunk(&s,p.to_str().unwrap(),first.next_offset.unwrap(),Some(first.revision.clone())).unwrap();assert_eq!(first.text+&second.text,original);assert!(second.next_offset.is_none());std::fs::write(&p,"changed").unwrap();assert!(read_chunk(&s,p.to_str().unwrap(),0,Some(first.revision)).unwrap_err().contains("CONFLICT"));}
 #[test]fn oversized_and_invalid_utf8_are_rejected_before_transfer(){let d=tempfile::tempdir().unwrap();let p=d.path().join("n.md");File::create(&p).unwrap().set_len(MAX_NOTE_BYTES+1).unwrap();assert!(revision(&p).unwrap_err().contains("NOTE_TOO_LARGE"));std::fs::write(&p,[255]).unwrap();assert!(read_chunk(&scope(d.path()),p.to_str().unwrap(),0,None).is_err());}
}
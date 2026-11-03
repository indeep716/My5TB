import {type Env,formatArtistName} from './contracts';
export async function control(env:Env){
  const c=await env.DB.prepare('SELECT * FROM sync_control WHERE dataset_id=?').bind(env.DATASET_ID||'models').first<Record<string,any>>();
  if(!c) throw new Error('Dataset is not initialized');
  return c;
}
export async function guarded(env:Env,generation:number,epoch:number,run:string|null,queries:D1PreparedStatement[]){
  // Validation and effects are in one transactional batch, closing the read/write race.
  const guard=env.DB.prepare(`INSERT INTO write_guards(id,valid) VALUES(1,CASE WHEN EXISTS(SELECT 1 FROM sync_control WHERE dataset_id=? AND generation=? AND lock_epoch=? AND mode='NORMAL' AND (? IS NULL OR active_run=?)) THEN 1 ELSE 0 END)`)
    .bind(env.DATASET_ID||'models',generation,epoch,run,run);
  try {await env.DB.batch([guard,...queries,env.DB.prepare('DELETE FROM write_guards WHERE id=1')]);}
  catch {throw new Error('CONFLICT: Cloud locked or stale writer fenced');}
}
export async function baseline(env:Env){
  const result=await env.DB.prepare("SELECT m.payload FROM models m JOIN content_items c ON c.id=m.content_id WHERE c.status!='DELETED' ORDER BY m.local_relative_path").all<{payload:string}>();
  return result.results.map(r=>{const m=JSON.parse(r.payload);m.artist_name=formatArtistName(m.artist_name);return m});
}

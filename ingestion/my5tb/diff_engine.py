from .contracts import Scan

def diff(scan: Scan, baseline: list[dict]) -> list[dict]:
    if not scan.complete:
        raise ValueError('Incomplete or invalid scan; synchronization blocked')
    current = {m['local_relative_path']: m for m in scan.models}
    old = {m['local_relative_path']: m for m in baseline}
    # A newly ignored subtree is protected, rather than interpreted as deleted.
    excluded = [x.casefold().rstrip('/') for x in scan.excluded]
    protected = lambda p: any(p.casefold() == x or p.casefold().startswith(x+'/') for x in excluded)
    ops = []
    for path in sorted(old.keys() - current.keys()):
        if not protected(path):
            ops.append({'kind':'DELETE_MODEL', 'path':path, 'before':old[path]})
    for path, item in sorted(current.items()):
        if path not in old:
            ops.append({'kind':'ADD_MODEL', 'path':path, 'model':item})
            continue
        def signature(model, kind):
            return sorted((f['path'],f['size'],f['mtime_ns']) for f in model['files'] if f['kind']==kind)
        for kind, op in [('model','UPDATE_FILE'),('image','UPDATE_IMAGE')]:
            if signature(item, kind) != signature(old[path], kind):
                ops.append({'kind':op, 'path':path, 'model':item, 'before':old[path]})
                continue
            # Baselines published before format detection or artist-name normalization republish metadata
            # (unchanged bytes reuse their remote IDs, so no file is transferred again).
            if kind=='model' and (any('formats' not in f for f in old[path]['files'] if f['kind']=='model') or item.get('artist_name') != old[path].get('artist_name')):
                ops.append({'kind':op, 'path':path, 'model':item, 'before':old[path]})
    return ops

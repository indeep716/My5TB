# Usage and architecture

## Collection layout

Set the root to your collection directory. Model endpoints contain `file/` and `picture/` directories:

```text
Collection/
  Characters/Realism/Artists/Artist/World/Character/Version/
    file/model.zip
    picture/main.png
```

Versions have independent identity. Paths determine identity: moving a model is a delete/add operation. Directories starting with `_` are never traversed. The scanner reads the source without modifying it.

## Owner workflow

Scan the collection, choose a main image and sub-images, then upload. Check the progress and final log. Completed models become catalog entries; unfinished models remain unpublished. Use the journal controls to resume or abandon a run. Publication controls hide/show models without removing stored files. Reset and deletion controls remove stored data: use a separate test deployment when evaluating them.

The submission inbox is separate from the catalog. Download and inspect submitted archives, organize approved assets in your local collection, then publish using ingestion. RAR/7z checks inspect metadata and declared model names; they do not establish that contents are safe. Do not execute untrusted submissions.

## Components

| Directory | Role |
| --- | --- |
| web | Vite catalog, contribution/contact pages, same-origin Pages API proxy |
| cloud/src | Worker catalog/admin/submission API |
| cloud/migrations | D1 schema migrations |
| ingestion/my5tb | Python GUI/CLI, scanner, journal, cloud clients and recovery |
| tests and cloud/tests | Python, browser and Worker tests |

Model files are stored in Google Drive; preview/original images and backup manifests in R2; metadata and upload state in D1. Submissions stay in private R2 storage pending owner review. The public catalog serves only published content. Noindex directives request crawler exclusion; they are not access control. Public download links can be shared.

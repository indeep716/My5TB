# Archive fixtures

No fixture is executed by these tests. Inspection reads metadata ranges only.

The following files are decoded from uuencoded fixtures in the official
[libarchive test directory](https://github.com/libarchive/libarchive/tree/b85b1ad628c50ab7ef8a276b8aeaceb0db55b3b2/libarchive/test)
(retrieved 2026-11-03; upstream snapshot `b85b1ad628c50ab7ef8a276b8aeaceb0db55b3b2`):

- `test_read_format_rar_compress_normal.rar`: real RAR4 compressed HTML/text and a symlink; admission must reject the link.
- `test_read_format_rar5_compressed.rar`: real RAR5 compressed `test.bin`; admission must reject absence of a supported model declaration.
- `test_read_format_7zip_lzma1.7z` and `test_read_format_7zip_lzma2.7z`: real compressed 7z data with plain headers and no supported model filename.

Upstream licensing is retained in `LIBARCHIVE-LICENSE.txt`.

Two explicitly modified derivatives test the metadata-only boundary:

- `declared-model-compressed-rar4.rar`: retain the first compressed HTML member from `test_read_format_rar_compress_normal.rar`, rename its header to `model.obj`, update the header length/name length/CRC, and drop other members including the symlink. Retain the original compressed payload, main header and end header.
- `declared-model-compressed-rar5.rar`: rename upstream `test.bin` to equal-length `test.obj`, update the file header CRC, retain all payload and other headers.

The derivatives **do not contain actual OBJ models**. They must be reported as declared model filenames requiring manual content review. They intentionally demonstrate that metadata admission cannot verify compressed model contents.

`model-lzma1-solid.7z` and `model-lzma2-solid.7z` were generated locally with
`py7zr 1.1.4` using `SevenZipFile(..., 'w', filters=[{'id': FILTER_LZMA or FILTER_LZMA2, 'dict_size': 1 << 20}])`.
Each contains `model.obj` (`v 0 0 0\nv 1 0 0\nv 0 1 0\n`) and `readme.txt`
(`companion note`) written with `writestr`. They have genuine compressed payloads,
a shared solid block and compressed LZMA2 headers. The decoder also has a test-generated
independent LZMA1 encoded-header case using the maintained `lzma1` encoder.

All other malformed, Unicode and sparse archive cases are built inside the test file.

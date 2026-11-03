import lzma
import struct
import pytest
from my5tb import formats

@pytest.mark.parametrize('marker', [b'\x03\x01\x01\x05\x5d'+struct.pack('<I',0xffffffff),b'\x21\x01\x28'])
def test_oversized_7z_dictionary_never_constructs_decoder(tmp_path,monkeypatch,marker):
    header=b'\x17\x06\x00\x01\x09\x01'+marker
    path=tmp_path/'model.7z'
    path.write_bytes(b"7z\xbc\xaf\x27\x1c"+b'\0'*6+struct.pack('<QQI',1,len(header),0)+b'x'+header)
    def forbidden(*args,**kwargs):raise AssertionError('Unsafe decoder allocation')
    monkeypatch.setattr(formats.lzma,'LZMADecompressor',forbidden)
    assert formats.archive_entries(path)==[]
    assert formats.describe(path)=={'formats':['7Z'],'contents':[]}

@pytest.mark.parametrize('kind',[lzma.FILTER_LZMA1,lzma.FILTER_LZMA2])
def test_valid_bounded_header_decodes(kind):
    filters={'id':kind,'dict_size':1<<20}
    plain=b'valid metadata'
    packed=lzma.compress(plain,format=lzma.FORMAT_RAW,filters=[filters])
    assert formats._decode_header(packed,filters)==plain

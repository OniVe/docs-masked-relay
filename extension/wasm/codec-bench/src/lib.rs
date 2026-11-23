//! Benchmark-only WASM codecs for the P1 codec ROI study.
//!
//! This crate is **not** linked into the extension. It exists to measure what
//! `quick-xml` and `miniz_oxide` would buy over the current `saxes` / `fflate`
//! JavaScript paths before any production integration is attempted.
//!
//! Raw ABI (no wasm-bindgen):
//!   alloc(len) -> ptr
//!   dealloc(ptr, len)
//!   xml_scan(ptr, len, out_ptr, want_hash) -> status
//!   inflate(ptr, len, out_ptr, out_cap, zlib) -> bytes_written | u32::MAX
//!   unzip(ptr, len, out_ptr, out_cap, meta_ptr, meta_cap) -> entry_count | error
//!
//! `xml_scan` writes seven little-endian u64 counters (56 bytes):
//!   starts, ends, attrs, text_events, cdata_events, utf16_units, hash
//! `hash` is FNV-1a 32 over UTF-16 code units; it is zero when `want_hash` is 0.
//!
//! `unzip` writes one 16-byte record per entry in central-directory order:
//!   name_hash:u32, out_offset:u32, out_size:u32, method:u32
//! `name_hash` is FNV-1a 32 over the raw name bytes in the central directory.
//! Error returns for `unzip`:
//!   u32::MAX       malformed / unsupported archive (ZIP64, encrypted)
//!   u32::MAX - 1   output or metadata buffer too small
//!   u32::MAX - 2   inflate failure

use std::cell::RefCell;

use miniz_oxide::inflate::stream::inflate;
use miniz_oxide::{DataFormat, MZFlush, MZStatus};
use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::Event;
use quick_xml::Reader;

const FNV_OFFSET: u32 = 0x811c_9dc5;
const FNV_PRIME: u32 = 0x0100_0193;

const XML_OK: u32 = 0;
const XML_INVALID_UTF8: u32 = 1;
const XML_MALFORMED: u32 = 2;

const UNZIP_MALFORMED: u32 = u32::MAX;
const UNZIP_TOO_SMALL: u32 = u32::MAX - 1;
const UNZIP_INFLATE: u32 = u32::MAX - 2;

thread_local! {
    static INFLATE_STATE: RefCell<Option<Box<miniz_oxide::inflate::stream::InflateState>>> =
        const { RefCell::new(None) };
}

/// Decompresses `input` into `out` in one `Finish` call. Returns the number of
/// bytes written only when the stream ended cleanly.
fn inflate_into(input: &[u8], out: &mut [u8], format: DataFormat) -> Option<usize> {
    INFLATE_STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        let state = state
            .get_or_insert_with(|| miniz_oxide::inflate::stream::InflateState::new_boxed(format));
        state.reset(format);
        let result = inflate(state, input, out, MZFlush::Finish);
        match result.status {
            Ok(MZStatus::StreamEnd) => Some(result.bytes_written),
            _ => None,
        }
    })
}

#[inline]
fn hash_u16(hash: &mut u32, value: u16) {
    *hash ^= value as u32;
    *hash = hash.wrapping_mul(FNV_PRIME);
}

#[inline]
fn hash_str(hash: &mut u32, value: &str) {
    for unit in value.encode_utf16() {
        hash_u16(hash, unit);
    }
}

#[inline]
fn utf16_units(value: &str) -> usize {
    if value.is_ascii() {
        value.len()
    } else {
        value.encode_utf16().count()
    }
}

fn name_of(event: &quick_xml::events::BytesStart<'_>) -> String {
    String::from_utf8_lossy(event.name().as_ref()).into_owned()
}

/// Counts attributes and (when hashing) folds the start tag into the digest in
/// the same order the JS side uses: marker, qname, then sorted `key=value`s.
fn count_start(
    event: &quick_xml::events::BytesStart<'_>,
    hashing: bool,
    hash: &mut u32,
) -> Result<u64, u32> {
    if hashing {
        hash_u16(hash, 1);
        hash_str(hash, &name_of(event));
    }
    let mut count = 0u64;
    let mut collected: Vec<(Vec<u8>, String)> = Vec::new();
    for attribute in event.attributes() {
        let attribute = attribute.map_err(|_| XML_MALFORMED)?;
        count += 1;
        if hashing {
            let value = attribute
                .unescape_value()
                .map_err(|_| XML_MALFORMED)?
                .into_owned();
            collected.push((attribute.key.as_ref().to_vec(), value));
        }
    }
    if hashing {
        collected.sort_by(|a, b| a.0.cmp(&b.0));
        for (key, value) in collected {
            hash_u16(hash, 2);
            hash_str(hash, &String::from_utf8_lossy(&key));
            hash_u16(hash, 3);
            hash_str(hash, &value);
        }
    }
    Ok(count)
}

fn write_u64(out: &mut [u8], index: usize, value: u64) {
    let base = index * 8;
    out[base..base + 8].copy_from_slice(&value.to_le_bytes());
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let layout = std::alloc::Layout::from_size_align(len, 1).expect("valid layout");
    // SAFETY: len > 0 and the layout is valid.
    unsafe { std::alloc::alloc(layout) }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let layout = std::alloc::Layout::from_size_align(len, 1).expect("valid layout");
    // SAFETY: pointer came from `alloc` with the same length.
    unsafe { std::alloc::dealloc(ptr, layout) }
}

/// Parses a UTF-8 XML document and writes the counter/hash record.
#[no_mangle]
pub extern "C" fn xml_scan(
    text_ptr: *const u8,
    text_len: usize,
    out_ptr: *mut u8,
    want_hash: u32,
) -> u32 {
    if text_ptr.is_null() || text_len == 0 || out_ptr.is_null() {
        return XML_MALFORMED;
    }
    // SAFETY: the caller guarantees a live buffer of text_len bytes.
    let input = unsafe { std::slice::from_raw_parts(text_ptr, text_len) };
    let text = match std::str::from_utf8(input) {
        Ok(text) => text,
        Err(_) => return XML_INVALID_UTF8,
    };

    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(false);
    let mut starts = 0u64;
    let mut ends = 0u64;
    let mut attrs = 0u64;
    let mut text_events = 0u64;
    let mut cdata_events = 0u64;
    let mut units = 0u64;
    let mut hash = FNV_OFFSET;
    let hashing = want_hash != 0;

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                starts += 1;
                match count_start(&event, hashing, &mut hash) {
                    Ok(count) => attrs += count,
                    Err(status) => return status,
                }
            }
            Ok(Event::Empty(event)) => {
                starts += 1;
                ends += 1;
                match count_start(&event, hashing, &mut hash) {
                    Ok(count) => attrs += count,
                    Err(status) => return status,
                }
                if hashing {
                    hash_u16(&mut hash, 4);
                    hash_str(&mut hash, &name_of(&event));
                }
            }
            Ok(Event::End(event)) => {
                ends += 1;
                if hashing {
                    hash_u16(&mut hash, 4);
                    hash_str(&mut hash, &String::from_utf8_lossy(event.name().as_ref()));
                }
            }
            Ok(Event::Text(event)) => {
                text_events += 1;
                let decoded = match event.xml10_content() {
                    Ok(decoded) => decoded,
                    Err(_) => return XML_MALFORMED,
                };
                units += utf16_units(&decoded) as u64;
                if hashing {
                    hash_u16(&mut hash, 5);
                    hash_str(&mut hash, &decoded);
                }
            }
            Ok(Event::CData(event)) => {
                cdata_events += 1;
                let decoded = match event.decode() {
                    Ok(decoded) => decoded,
                    Err(_) => return XML_MALFORMED,
                };
                units += utf16_units(&decoded) as u64;
                if hashing {
                    hash_u16(&mut hash, 6);
                    hash_str(&mut hash, &decoded);
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                // OPC forbids DTDs, so only character refs and the five
                // predefined entities can be resolved. Anything else is an
                // undeclared entity and therefore not well-formed for us.
                let name = match reference.decode() {
                    Ok(name) => name,
                    Err(_) => return XML_MALFORMED,
                };
                let char_ref = match reference.resolve_char_ref() {
                    Ok(value) => value,
                    Err(_) => return XML_MALFORMED,
                };
                let value = if let Some(value) = char_ref {
                    value.to_string()
                } else if let Some(entity) = resolve_predefined_entity(&name) {
                    entity.to_string()
                } else {
                    return XML_MALFORMED;
                };
                units += utf16_units(&value) as u64;
                if hashing {
                    hash_u16(&mut hash, 5);
                    hash_str(&mut hash, &value);
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => return XML_MALFORMED,
        }
    }

    // SAFETY: the caller guarantees at least 56 writable bytes at out_ptr.
    let out = unsafe { std::slice::from_raw_parts_mut(out_ptr, 56) };
    write_u64(out, 0, starts);
    write_u64(out, 1, ends);
    write_u64(out, 2, attrs);
    write_u64(out, 3, text_events);
    write_u64(out, 4, cdata_events);
    write_u64(out, 5, units);
    write_u64(out, 6, hash as u64);
    XML_OK
}

#[no_mangle]
pub extern "C" fn inflate_stream(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
    zlib: u32,
) -> u32 {
    if ptr.is_null() || len == 0 || out_ptr.is_null() || out_cap == 0 {
        return u32::MAX;
    }
    // SAFETY: live input/output buffers guaranteed by the caller.
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    let out = unsafe { std::slice::from_raw_parts_mut(out_ptr, out_cap) };
    let format = if zlib != 0 {
        DataFormat::Zlib
    } else {
        DataFormat::Raw
    };
    match inflate_into(input, out, format) {
        Some(written) => written as u32,
        None => u32::MAX,
    }
}

#[inline]
fn read_u16(data: &[u8], offset: usize) -> Option<u16> {
    let bytes = data.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

#[inline]
fn read_u32(data: &[u8], offset: usize) -> Option<u32> {
    let bytes = data.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn find_eocd(data: &[u8]) -> Option<usize> {
    if data.len() < 22 {
        return None;
    }
    let start = data.len().saturating_sub(22 + 0xffff);
    (start..=data.len() - 22)
        .rev()
        .find(|&offset| read_u32(data, offset) == Some(0x0605_4b50))
}

/// Parses a non-ZIP64 archive and inflates every entry into `out`.
#[no_mangle]
pub extern "C" fn unzip(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
    meta_ptr: *mut u8,
    meta_cap: usize,
) -> u32 {
    if ptr.is_null() || len == 0 || out_ptr.is_null() || out_cap == 0 || meta_ptr.is_null() {
        return UNZIP_MALFORMED;
    }
    // SAFETY: live buffers guaranteed by the caller.
    let data = unsafe { std::slice::from_raw_parts(ptr, len) };
    let eocd = match find_eocd(data) {
        Some(offset) => offset,
        None => return UNZIP_MALFORMED,
    };
    let entries = match read_u16(data, eocd + 10) {
        Some(value) => value as usize,
        None => return UNZIP_MALFORMED,
    };
    let cd_size = match read_u32(data, eocd + 12) {
        Some(value) => value as usize,
        None => return UNZIP_MALFORMED,
    };
    let cd_offset = match read_u32(data, eocd + 16) {
        Some(value) => value as usize,
        None => return UNZIP_MALFORMED,
    };
    if entries == 0xffff || cd_size == 0xffff_ffff || cd_offset == 0xffff_ffff {
        return UNZIP_MALFORMED;
    }
    if cd_offset > data.len() || cd_offset + cd_size > data.len() {
        return UNZIP_MALFORMED;
    }
    if entries > meta_cap {
        return UNZIP_TOO_SMALL;
    }

    let mut cursor = 0usize;
    let mut cd = cd_offset;
    for index in 0..entries {
        if read_u32(data, cd) != Some(0x0201_4b50) {
            return UNZIP_MALFORMED;
        }
        let flags = match read_u16(data, cd + 8) {
            Some(value) => value,
            None => return UNZIP_MALFORMED,
        };
        let method = match read_u16(data, cd + 10) {
            Some(value) => value,
            None => return UNZIP_MALFORMED,
        };
        let compressed_size = match read_u32(data, cd + 20) {
            Some(value) => value as usize,
            None => return UNZIP_MALFORMED,
        };
        let uncompressed_size = match read_u32(data, cd + 24) {
            Some(value) => value as usize,
            None => return UNZIP_MALFORMED,
        };
        let name_len = match read_u16(data, cd + 28) {
            Some(value) => value as usize,
            None => return UNZIP_MALFORMED,
        };
        let extra_len = match read_u16(data, cd + 30) {
            Some(value) => value as usize,
            None => return UNZIP_MALFORMED,
        };
        let comment_len = match read_u16(data, cd + 32) {
            Some(value) => value as usize,
            None => return UNZIP_MALFORMED,
        };
        let local_offset = match read_u32(data, cd + 42) {
            Some(value) => value as usize,
            None => return UNZIP_MALFORMED,
        };
        if flags & 1 != 0 || (method != 0 && method != 8) {
            return UNZIP_MALFORMED;
        }
        let name_start = cd + 46;
        let name_end = match name_start.checked_add(name_len) {
            Some(value) if value <= data.len() => value,
            _ => return UNZIP_MALFORMED,
        };
        let name = &data[name_start..name_end];
        let mut name_hash = FNV_OFFSET;
        for byte in name {
            name_hash ^= *byte as u32;
            name_hash = name_hash.wrapping_mul(FNV_PRIME);
        }

        if read_u32(data, local_offset) != Some(0x0403_4b50) {
            return UNZIP_MALFORMED;
        }
        let local_name_len = match read_u16(data, local_offset + 26) {
            Some(value) => value as usize,
            None => return UNZIP_MALFORMED,
        };
        let local_extra_len = match read_u16(data, local_offset + 28) {
            Some(value) => value as usize,
            None => return UNZIP_MALFORMED,
        };
        let data_start = match local_offset
            .checked_add(30)
            .and_then(|value| value.checked_add(local_name_len))
            .and_then(|value| value.checked_add(local_extra_len))
        {
            Some(value) if value + compressed_size <= data.len() => value,
            _ => return UNZIP_MALFORMED,
        };
        let data_end = data_start + compressed_size;
        if cursor + uncompressed_size > out_cap {
            return UNZIP_TOO_SMALL;
        }

        // SAFETY: bounds checked above.
        let target =
            unsafe { std::slice::from_raw_parts_mut(out_ptr.add(cursor), uncompressed_size) };
        if method == 0 {
            if compressed_size != uncompressed_size {
                return UNZIP_MALFORMED;
            }
            target.copy_from_slice(&data[data_start..data_end]);
        } else {
            match inflate_into(&data[data_start..data_end], target, DataFormat::Raw) {
                Some(written) if written == uncompressed_size => {}
                _ => return UNZIP_INFLATE,
            }
        }

        // SAFETY: `index < entries <= meta_cap`; 16 bytes per record.
        let meta = unsafe { std::slice::from_raw_parts_mut(meta_ptr.add(index * 16), 16) };
        meta[0..4].copy_from_slice(&name_hash.to_le_bytes());
        meta[4..8].copy_from_slice(&(cursor as u32).to_le_bytes());
        meta[8..12].copy_from_slice(&(uncompressed_size as u32).to_le_bytes());
        meta[12..16].copy_from_slice(&(method as u32).to_le_bytes());

        cursor += uncompressed_size;
        cd = name_end + extra_len + comment_len;
    }

    entries as u32
}

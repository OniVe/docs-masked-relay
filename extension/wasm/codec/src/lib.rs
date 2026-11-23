//! Production ZIP/DEFLATE codec for DocsMasked OPC packages.
//!
//! Raw ABI (no wasm-bindgen):
//!   alloc(len) -> ptr
//!   dealloc(ptr, len)
//!   unzip(ptr, len, out_ptr, out_cap) -> entry_count | error
//!   inflate(ptr, len, out_ptr, out_cap, zlib) -> bytes_written | error
//!
//! `unzip` is called only after the JavaScript `inspectZip` guards have
//! validated the archive (ZIP64/encryption/method/limits). It writes the
//! decompressed entries consecutively to `out_ptr` in central-directory order
//! and returns the number of entries. The caller knows each entry's
//! uncompressed size from the central directory and copies the slices out.
//!
//! This module deliberately does not validate part names, relationships or
//! content types; those remain JavaScript policy. Any malformed archive or
//! inflate failure returns an error and the JS caller falls back to fflate.
//!
//! Error returns:
//!   u32::MAX       malformed / unsupported archive
//!   u32::MAX - 1   output buffer too small
//!   u32::MAX - 2   inflate failure

use std::cell::RefCell;

use miniz_oxide::inflate::stream::inflate;
use miniz_oxide::{DataFormat, MZFlush, MZStatus};

const ERR_MALFORMED: u32 = u32::MAX;
const ERR_TOO_SMALL: u32 = u32::MAX - 1;
const ERR_INFLATE: u32 = u32::MAX - 2;

const ZIP64_LIMIT: u32 = 0xffff_ffff;

thread_local! {
    static INFLATE_STATE: RefCell<Option<Box<miniz_oxide::inflate::stream::InflateState>>> =
        const { RefCell::new(None) };
}

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
fn read_u16(data: &[u8], offset: usize) -> Option<u16> {
    let bytes = data.get(offset..offset.checked_add(2)?)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

#[inline]
fn read_u32(data: &[u8], offset: usize) -> Option<u32> {
    let bytes = data.get(offset..offset.checked_add(4)?)?;
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

#[derive(Clone, Copy)]
struct Entry {
    data_start: usize,
    compressed_size: usize,
    uncompressed_size: usize,
    method: u16,
}

fn parse_entry(
    data: &[u8],
    central: usize,
    central_offset: usize,
    central_end: usize,
) -> Option<(Entry, usize)> {
    if central.checked_add(46)? > central_end {
        return None;
    }
    if read_u32(data, central)? != 0x0201_4b50 {
        return None;
    }
    let flags = read_u16(data, central + 8)?;
    let method = read_u16(data, central + 10)?;
    let compressed_size = read_u32(data, central + 20)? as usize;
    let uncompressed_size = read_u32(data, central + 24)? as usize;
    let name_len = read_u16(data, central + 28)? as usize;
    let extra_len = read_u16(data, central + 30)? as usize;
    let comment_len = read_u16(data, central + 32)? as usize;
    let local_offset = read_u32(data, central + 42)? as usize;

    if flags & 0x0001 != 0 || flags & 0x0040 != 0 {
        return None;
    }
    if method != 0 && method != 8 {
        return None;
    }
    if compressed_size as u32 == ZIP64_LIMIT || uncompressed_size as u32 == ZIP64_LIMIT {
        return None;
    }

    let name_start = central.checked_add(46)?;
    let name_end = name_start.checked_add(name_len)?;
    let extra_end = name_end.checked_add(extra_len)?;
    let entry_end = extra_end.checked_add(comment_len)?;
    if entry_end > central_end {
        return None;
    }
    // A ZIP64 extra field is rejected even when 32-bit sizes are populated.
    let mut extra_cursor = name_end;
    while extra_cursor.checked_add(4)? <= extra_end {
        let header_id = read_u16(data, extra_cursor)?;
        let header_size = read_u16(data, extra_cursor + 2)? as usize;
        if header_id == 0x0001 {
            return None;
        }
        extra_cursor = extra_cursor.checked_add(4)?.checked_add(header_size)?;
        if extra_cursor > extra_end {
            return None;
        }
    }

    if local_offset.checked_add(30)? > central_offset {
        return None;
    }
    if read_u32(data, local_offset)? != 0x0403_4b50 {
        return None;
    }
    let local_flags = read_u16(data, local_offset + 6)?;
    let local_method = read_u16(data, local_offset + 8)?;
    let local_name_len = read_u16(data, local_offset + 26)? as usize;
    let local_extra_len = read_u16(data, local_offset + 28)? as usize;
    if local_flags & 0x0001 != 0 || local_flags & 0x0040 != 0 {
        return None;
    }
    if local_method != method {
        return None;
    }
    let data_start = local_offset
        .checked_add(30)?
        .checked_add(local_name_len)?
        .checked_add(local_extra_len)?;
    let data_end = data_start.checked_add(compressed_size)?;
    if data_start > central_offset || data_end > central_offset {
        return None;
    }

    Some((
        Entry {
            data_start,
            compressed_size,
            uncompressed_size,
            method,
        },
        entry_end,
    ))
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

#[no_mangle]
pub extern "C" fn unzip(ptr: *const u8, len: usize, out_ptr: *mut u8, out_cap: usize) -> u32 {
    if ptr.is_null() || len == 0 || out_ptr.is_null() {
        return ERR_MALFORMED;
    }
    // SAFETY: live input buffer guaranteed by the caller.
    let data = unsafe { std::slice::from_raw_parts(ptr, len) };
    let eocd = match find_eocd(data) {
        Some(offset) => offset,
        None => return ERR_MALFORMED,
    };
    let entries = match read_u16(data, eocd + 10) {
        Some(value) => value as usize,
        None => return ERR_MALFORMED,
    };
    let central_size = match read_u32(data, eocd + 12) {
        Some(value) => value as usize,
        None => return ERR_MALFORMED,
    };
    let central_offset = match read_u32(data, eocd + 16) {
        Some(value) => value as usize,
        None => return ERR_MALFORMED,
    };
    if entries == 0
        || entries == 0xffff
        || central_size == ZIP64_LIMIT as usize
        || central_offset == ZIP64_LIMIT as usize
    {
        return ERR_MALFORMED;
    }
    let central_end = match central_offset.checked_add(central_size) {
        Some(value) if value <= eocd => value,
        _ => return ERR_MALFORMED,
    };

    // First pass: validate the central directory and the local data bounds,
    // and prove the output buffer is large enough before writing anything.
    let mut parsed: Vec<Entry> = Vec::with_capacity(entries);
    let mut cursor = central_offset;
    let mut total = 0usize;
    for _ in 0..entries {
        let (entry, next) = match parse_entry(data, cursor, central_offset, central_end) {
            Some(value) => value,
            None => return ERR_MALFORMED,
        };
        total = match total.checked_add(entry.uncompressed_size) {
            Some(value) => value,
            None => return ERR_MALFORMED,
        };
        parsed.push(entry);
        cursor = next;
    }
    if cursor != central_end || total > out_cap {
        return if total > out_cap {
            ERR_TOO_SMALL
        } else {
            ERR_MALFORMED
        };
    }

    // Second pass: inflate/copy entries consecutively into the caller buffer.
    let mut out_offset = 0usize;
    for entry in &parsed {
        // SAFETY: bounds were proved in the first pass and out_cap >= total.
        let out = unsafe {
            std::slice::from_raw_parts_mut(out_ptr.add(out_offset), entry.uncompressed_size)
        };
        let input = &data[entry.data_start..entry.data_start + entry.compressed_size];
        if entry.method == 0 {
            if entry.compressed_size != entry.uncompressed_size {
                return ERR_MALFORMED;
            }
            out.copy_from_slice(input);
        } else {
            match inflate_into(input, out, DataFormat::Raw) {
                Some(written) if written == entry.uncompressed_size => {}
                _ => return ERR_INFLATE,
            }
        }
        out_offset += entry.uncompressed_size;
    }

    parsed.len() as u32
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
        return ERR_MALFORMED;
    }
    // SAFETY: live buffers guaranteed by the caller.
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    let out = unsafe { std::slice::from_raw_parts_mut(out_ptr, out_cap) };
    let format = if zlib != 0 {
        DataFormat::Zlib
    } else {
        DataFormat::Raw
    };
    match inflate_into(input, out, format) {
        Some(written) => written as u32,
        None => ERR_INFLATE,
    }
}

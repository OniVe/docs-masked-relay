//! Candidate-region scanner for the structured PII detectors.
//!
//! The JavaScript detectors are regular expressions with Unicode lookarounds.
//! Re-implementing those exact semantics in Rust would duplicate a large, subtle
//! grammar, so this module only does the O(n) part: it finds maximal regions
//! that can contain a match of one detector family. The JS side then runs the
//! unchanged detector regex on each small region (with one character of true
//! left/right context), which keeps matching semantics byte-for-byte identical.
//!
//! ABI (no wasm-bindgen):
//!   alloc(len) -> ptr
//!   dealloc(ptr, len)
//!   scan(text_ptr, text_len, out_ptr, out_cap) -> count
//!
//! `out_cap` is a record count. Each record is 12 bytes:
//!   start:u32, end:u32, label:u8, _pad:u8, rule:u16
//! Offsets are UTF-8 byte offsets into the scanned buffer.
//!
//! Return values:
//!   >= 0                 records written (also the required count)
//!   OUT_TOO_SMALL        out_cap was too small; nothing was written
//!   FALLBACK             too many candidates; the caller must use the JS path
//!
//! Region labels are detector *families*, not entity labels: the JS wrapper
//! maps them to the detectors that must be re-run on the region.

use std::alloc::{alloc as raw_alloc, dealloc as raw_dealloc, Layout};

const OUT_TOO_SMALL: u32 = u32::MAX;
const FALLBACK: u32 = u32::MAX - 1;
const MAX_CANDIDATES: usize = 250_000;

const LABEL_EMAIL: u8 = 1;
const LABEL_URL: u8 = 2;
const LABEL_HANDLE: u8 = 3;
const LABEL_NUMERIC: u8 = 4;
const LABEL_LICENSE: u8 = 5;
const LABEL_IBAN: u8 = 6;

#[repr(C)]
#[derive(Clone, Copy)]
struct RawSpan {
    start: u32,
    end: u32,
    label: u8,
    pad: u8,
    rule: u16,
}

#[inline]
fn is_digit(b: u8) -> bool {
    b.is_ascii_digit()
}

#[inline]
fn is_upper(b: u8) -> bool {
    b.is_ascii_uppercase()
}

#[inline]
fn is_email_local(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'%' | b'+' | b'-')
}

#[inline]
fn is_domain(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-')
}

#[inline]
fn is_url_tail(b: u8) -> bool {
    !matches!(b, b' ' | b'\t' | b'\n' | b'\r' | b'<' | b'>' | b'"' | b'\'' | b')' | b']')
}

#[inline]
fn is_handle(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

#[inline]
fn is_utf8_continuation(b: u8) -> bool {
    b & 0xC0 == 0x80
}

/// Start of the UTF-8 sequence containing byte `i` (or the previous character
/// when `i` is already a boundary). Used to include one true context character.
fn prev_char_start(bytes: &[u8], i: usize) -> usize {
    if i == 0 {
        return 0;
    }
    let mut at = i - 1;
    while at > 0 && is_utf8_continuation(bytes[at]) {
        at -= 1;
    }
    at
}

fn next_char_end(bytes: &[u8], i: usize) -> usize {
    let len = bytes.len();
    if i >= len {
        return len;
    }
    let mut at = i + 1;
    while at < len && is_utf8_continuation(bytes[at]) {
        at += 1;
    }
    at
}

/// Length in bytes of a numeric-window character at `i`, or 0.
/// Includes en/em dashes because the phone grammar accepts them.
fn numeric_class_len(bytes: &[u8], i: usize) -> usize {
    let b = bytes[i];
    if is_digit(b) || matches!(b, b' ' | b'\t' | b'.' | b'-' | b'/' | b'(' | b')') {
        return 1;
    }
    if b == 0xE2
        && i + 2 < bytes.len()
        && bytes[i + 1] == 0x80
        && (bytes[i + 2] == 0x93 || bytes[i + 2] == 0x94)
    {
        return 3;
    }
    0
}

/// Cyrillic uppercase `А-Я` / `Ё` (UTF-8). Latin uppercase is accepted too:
/// over-inclusion is safe, the JS regex decides.
fn cyrillic_upper_len(bytes: &[u8], i: usize) -> usize {
    let b = bytes[i];
    if b == 0xD0 && i + 1 < bytes.len() {
        let t = bytes[i + 1];
        if (0x90..=0xAF).contains(&t) || t == 0x81 {
            return 2;
        }
    }
    0
}

fn license_class_len(bytes: &[u8], i: usize) -> usize {
    let b = bytes[i];
    if is_digit(b) || is_upper(b) || matches!(b, b' ' | b'\t' | b'-' | b'/') {
        return 1;
    }
    cyrillic_upper_len(bytes, i)
}

fn starts_ci(bytes: &[u8], at: usize, needle: &[u8]) -> bool {
    if at + needle.len() > bytes.len() {
        return false;
    }
    for (offset, want) in needle.iter().enumerate() {
        let got = bytes[at + offset];
        if got.to_ascii_lowercase() != *want {
            return false;
        }
    }
    true
}

fn push_region(out: &mut Vec<RawSpan>, bytes: &[u8], start: usize, end: usize, label: u8) {
    if start >= end || end > bytes.len() {
        return;
    }
    let s = prev_char_start(bytes, start);
    let e = next_char_end(bytes, end);
    out.push(RawSpan {
        start: s as u32,
        end: e as u32,
        label,
        pad: 0,
        rule: label as u16,
    });
}

fn scan_email(bytes: &[u8], out: &mut Vec<RawSpan>) {
    for i in 0..bytes.len() {
        if bytes[i] != b'@' {
            continue;
        }
        let mut start = i;
        while start > 0 && is_email_local(bytes[start - 1]) {
            start -= 1;
        }
        let mut end = i + 1;
        while end < bytes.len() && is_domain(bytes[end]) {
            end += 1;
        }
        if start == i || end == i + 1 {
            continue;
        }
        if !bytes[i + 1..end].contains(&b'.') {
            continue;
        }
        push_region(out, bytes, start, end, LABEL_EMAIL);
    }
}

fn scan_url(bytes: &[u8], out: &mut Vec<RawSpan>) {
    let mut i = 0;
    while i < bytes.len() {
        let lower = bytes[i].to_ascii_lowercase();
        let prefix_len = if lower == b'h' && starts_ci(bytes, i, b"https://") {
            Some(8)
        } else if lower == b'h' && starts_ci(bytes, i, b"http://") {
            Some(7)
        } else if lower == b'w' && starts_ci(bytes, i, b"www.") {
            Some(4)
        } else {
            None
        };
        if let Some(prefix) = prefix_len {
            let mut end = i + prefix;
            while end < bytes.len() && is_url_tail(bytes[end]) {
                end += 1;
            }
            if end > i + prefix {
                push_region(out, bytes, i, end, LABEL_URL);
                i = end;
                continue;
            }
        }
        i += 1;
    }
}

fn scan_handle(bytes: &[u8], out: &mut Vec<RawSpan>) {
    for i in 0..bytes.len() {
        if bytes[i] != b'@' || i + 1 >= bytes.len() || !bytes[i + 1].is_ascii_alphabetic() {
            continue;
        }
        let mut end = i + 2;
        while end < bytes.len() && is_handle(bytes[end]) {
            end += 1;
        }
        // `@` + letter + 3..31 more characters.
        if end - i >= 5 {
            push_region(out, bytes, i, end, LABEL_HANDLE);
        }
    }
}

fn scan_numeric(bytes: &[u8], out: &mut Vec<RawSpan>) {
    let mut i = 0;
    while i < bytes.len() {
        if !is_digit(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        let mut digits = 0usize;
        let mut has_dot = false;
        let mut end = i;
        while end < bytes.len() {
            let step = numeric_class_len(bytes, end);
            if step == 0 {
                break;
            }
            if step == 1 {
                if is_digit(bytes[end]) {
                    digits += 1;
                } else if bytes[end] == b'.' {
                    has_dot = true;
                }
            }
            end += step;
        }
        if digits >= 5 || (digits >= 4 && has_dot) {
            push_region(out, bytes, start, end, LABEL_NUMERIC);
        }
        i = end;
    }
}

fn scan_license(bytes: &[u8], out: &mut Vec<RawSpan>) {
    let mut i = 0;
    while i < bytes.len() {
        if license_class_len(bytes, i) == 0 {
            i += 1;
            continue;
        }
        let start = i;
        let mut digits = 0usize;
        let mut has_cyrillic = false;
        let mut end = i;
        while end < bytes.len() {
            let step = license_class_len(bytes, end);
            if step == 0 {
                break;
            }
            if step == 1 {
                if is_digit(bytes[end]) {
                    digits += 1;
                }
            } else {
                has_cyrillic = true;
            }
            end += step;
        }
        if digits >= 5 && has_cyrillic {
            push_region(out, bytes, start, end, LABEL_LICENSE);
        }
        i = end.max(i + 1);
    }
}

fn scan_iban(bytes: &[u8], out: &mut Vec<RawSpan>) {
    let mut i = 0;
    while i + 3 < bytes.len() {
        if is_upper(bytes[i]) && is_upper(bytes[i + 1]) && is_digit(bytes[i + 2]) && is_digit(bytes[i + 3])
        {
            let start = i;
            let mut end = i + 4;
            while end < bytes.len()
                && end - start < 64
                && (is_upper(bytes[end]) || is_digit(bytes[end]) || bytes[end] == b' ')
            {
                end += 1;
            }
            push_region(out, bytes, start, end, LABEL_IBAN);
            i = end;
        } else {
            i += 1;
        }
    }
}

/// Sorts by `(label, start)` and merges overlapping regions of one family.
fn merge(regions: &mut Vec<RawSpan>) {
    regions.sort_unstable_by_key(|r| (r.label, r.start));
    let mut write = 0usize;
    for read in 0..regions.len() {
        let candidate = regions[read];
        if write > 0 {
            let last = &mut regions[write - 1];
            if last.label == candidate.label && candidate.start <= last.end {
                if candidate.end > last.end {
                    last.end = candidate.end;
                }
                continue;
            }
        }
        regions[write] = candidate;
        write += 1;
    }
    regions.truncate(write);
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let layout = Layout::from_size_align(len, 1).expect("valid layout");
    // SAFETY: len > 0, layout is valid.
    unsafe { raw_alloc(layout) }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let layout = Layout::from_size_align(len, 1).expect("valid layout");
    // SAFETY: pointer came from `alloc` with the same length.
    unsafe { raw_dealloc(ptr, layout) }
}

#[no_mangle]
pub extern "C" fn scan(text_ptr: *const u8, text_len: usize, out_ptr: *mut u8, out_cap: usize) -> u32 {
    if text_ptr.is_null() || text_len == 0 || out_ptr.is_null() || out_cap == 0 {
        return 0;
    }
    // SAFETY: the JS caller guarantees a live buffer of text_len bytes.
    let bytes = unsafe { std::slice::from_raw_parts(text_ptr, text_len) };
    let mut regions: Vec<RawSpan> = Vec::with_capacity(64);
    scan_email(bytes, &mut regions);
    scan_url(bytes, &mut regions);
    scan_handle(bytes, &mut regions);
    scan_numeric(bytes, &mut regions);
    scan_license(bytes, &mut regions);
    scan_iban(bytes, &mut regions);
    merge(&mut regions);

    if regions.len() > MAX_CANDIDATES {
        return FALLBACK;
    }
    if regions.len() > out_cap {
        return OUT_TOO_SMALL;
    }
    // SAFETY: out_cap records worth of bytes are available.
    let out = unsafe { std::slice::from_raw_parts_mut(out_ptr, out_cap * 12) };
    for (index, region) in regions.iter().enumerate() {
        let base = index * 12;
        out[base..base + 4].copy_from_slice(&region.start.to_le_bytes());
        out[base + 4..base + 8].copy_from_slice(&region.end.to_le_bytes());
        out[base + 8] = region.label;
        out[base + 9] = region.pad;
        out[base + 10..base + 12].copy_from_slice(&region.rule.to_le_bytes());
    }
    regions.len() as u32
}

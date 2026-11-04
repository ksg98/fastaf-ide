// Copyright 2015 The Rust Project Developers. See the COPYRIGHT
// file at the top-level directory of this distribution and at
// http://rust-lang.org/COPYRIGHT.
//
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

// TUICommander patch: vendored from the `fxhash` 0.2.1 crate (RUSTSEC-2025-0057,
// unmaintained) to drop the dependency. Only the three hashers and the three
// free functions this fork's embedder uses are kept; `FxBuildHasher` /
// `FxHashMap` / `FxHashSet` are dropped as dead weight. The only behavioural
// change is that the upstream `byteorder::NativeEndian` reads are replaced with
// `u32::from_ne_bytes` / `u64::from_ne_bytes` — same bytes in, same integer out,
// so the algorithm output is bit-identical (pinned by the golden-vector test
// below, which is checked against the real fxhash 0.2.1 crate).

use std::hash::Hasher;
use std::ops::BitXor;

const ROTATE: u32 = 5;
const SEED64: u64 = 0x517cc1b727220a95;
const SEED32: u32 = (SEED64 & 0xFFFF_FFFF) as u32;

#[cfg(target_pointer_width = "32")]
const SEED: usize = SEED32 as usize;
#[cfg(target_pointer_width = "64")]
const SEED: usize = SEED64 as usize;

trait HashWord {
    fn hash_word(&mut self, word: Self);
}

macro_rules! impl_hash_word {
    ($($ty:ty = $key:ident),* $(,)*) => (
        $(
            impl HashWord for $ty {
                #[inline]
                fn hash_word(&mut self, word: Self) {
                    *self = self.rotate_left(ROTATE).bitxor(word).wrapping_mul($key);
                }
            }
        )*
    )
}

impl_hash_word!(usize = SEED, u32 = SEED32, u64 = SEED64);

#[inline]
fn write32(mut hash: u32, mut bytes: &[u8]) -> u32 {
    while bytes.len() >= 4 {
        let n = u32::from_ne_bytes(bytes[..4].try_into().unwrap());
        hash.hash_word(n);
        bytes = bytes.split_at(4).1;
    }

    for byte in bytes {
        hash.hash_word(*byte as u32);
    }
    hash
}

#[inline]
fn write64(mut hash: u64, mut bytes: &[u8]) -> u64 {
    while bytes.len() >= 8 {
        let n = u64::from_ne_bytes(bytes[..8].try_into().unwrap());
        hash.hash_word(n);
        bytes = bytes.split_at(8).1;
    }

    if bytes.len() >= 4 {
        let n = u32::from_ne_bytes(bytes[..4].try_into().unwrap());
        hash.hash_word(n as u64);
        bytes = bytes.split_at(4).1;
    }

    for byte in bytes {
        hash.hash_word(*byte as u64);
    }
    hash
}

#[inline]
#[cfg(target_pointer_width = "32")]
fn write(hash: usize, bytes: &[u8]) -> usize {
    write32(hash as u32, bytes) as usize
}

#[inline]
#[cfg(target_pointer_width = "64")]
fn write(hash: usize, bytes: &[u8]) -> usize {
    write64(hash as u64, bytes) as usize
}

/// This hashing algorithm was extracted from the Rustc compiler.
/// This is the same hashing algoirthm used for some internal operations in FireFox.
/// The strength of this algorithm is in hashing 8 bytes at a time on 64-bit platforms,
/// where the FNV algorithm works on one byte at a time.
///
/// This hashing algorithm should not be used for cryptographic, or in scenarios where
/// DOS attacks are a concern.
#[derive(Debug, Clone)]
pub(crate) struct FxHasher {
    hash: usize,
}

impl Default for FxHasher {
    #[inline]
    fn default() -> FxHasher {
        FxHasher { hash: 0 }
    }
}

impl Hasher for FxHasher {
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        self.hash = write(self.hash, bytes);
    }

    #[inline]
    fn write_u8(&mut self, i: u8) {
        self.hash.hash_word(i as usize);
    }

    #[inline]
    fn write_u16(&mut self, i: u16) {
        self.hash.hash_word(i as usize);
    }

    #[inline]
    fn write_u32(&mut self, i: u32) {
        self.hash.hash_word(i as usize);
    }

    #[inline]
    #[cfg(target_pointer_width = "32")]
    fn write_u64(&mut self, i: u64) {
        self.hash.hash_word(i as usize);
        self.hash.hash_word((i >> 32) as usize);
    }

    #[inline]
    #[cfg(target_pointer_width = "64")]
    fn write_u64(&mut self, i: u64) {
        self.hash.hash_word(i as usize);
    }

    #[inline]
    fn write_usize(&mut self, i: usize) {
        self.hash.hash_word(i);
    }

    #[inline]
    fn finish(&self) -> u64 {
        self.hash as u64
    }
}

/// This hashing algorithm was extracted from the Rustc compiler.
/// This is the same hashing algoirthm used for some internal operations in FireFox.
/// The strength of this algorithm is in hashing 8 bytes at a time on any platform,
/// where the FNV algorithm works on one byte at a time.
///
/// This hashing algorithm should not be used for cryptographic, or in scenarios where
/// DOS attacks are a concern.
#[derive(Debug, Clone)]
pub(crate) struct FxHasher64 {
    hash: u64,
}

impl Default for FxHasher64 {
    #[inline]
    fn default() -> FxHasher64 {
        FxHasher64 { hash: 0 }
    }
}

impl Hasher for FxHasher64 {
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        self.hash = write64(self.hash, bytes);
    }

    #[inline]
    fn write_u8(&mut self, i: u8) {
        self.hash.hash_word(i as u64);
    }

    #[inline]
    fn write_u16(&mut self, i: u16) {
        self.hash.hash_word(i as u64);
    }

    #[inline]
    fn write_u32(&mut self, i: u32) {
        self.hash.hash_word(i as u64);
    }

    fn write_u64(&mut self, i: u64) {
        self.hash.hash_word(i);
    }

    #[inline]
    fn write_usize(&mut self, i: usize) {
        self.hash.hash_word(i as u64);
    }

    #[inline]
    fn finish(&self) -> u64 {
        self.hash
    }
}

/// This hashing algorithm was extracted from the Rustc compiler.
/// This is the same hashing algoirthm used for some internal operations in FireFox.
/// The strength of this algorithm is in hashing 4 bytes at a time on any platform,
/// where the FNV algorithm works on one byte at a time.
///
/// This hashing algorithm should not be used for cryptographic, or in scenarios where
/// DOS attacks are a concern.
#[derive(Debug, Clone)]
pub(crate) struct FxHasher32 {
    hash: u32,
}

impl Default for FxHasher32 {
    #[inline]
    fn default() -> FxHasher32 {
        FxHasher32 { hash: 0 }
    }
}

impl Hasher for FxHasher32 {
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        self.hash = write32(self.hash, bytes);
    }

    #[inline]
    fn write_u8(&mut self, i: u8) {
        self.hash.hash_word(i as u32);
    }

    #[inline]
    fn write_u16(&mut self, i: u16) {
        self.hash.hash_word(i as u32);
    }

    #[inline]
    fn write_u32(&mut self, i: u32) {
        self.hash.hash_word(i);
    }

    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.hash.hash_word(i as u32);
        self.hash.hash_word((i >> 32) as u32);
    }

    #[inline]
    #[cfg(target_pointer_width = "32")]
    fn write_usize(&mut self, i: usize) {
        self.write_u32(i as u32);
    }

    #[inline]
    #[cfg(target_pointer_width = "64")]
    fn write_usize(&mut self, i: usize) {
        self.write_u64(i as u64);
    }

    #[inline]
    fn finish(&self) -> u64 {
        self.hash as u64
    }
}

/// A convenience function for when you need a quick 64-bit hash.
#[inline]
pub(crate) fn hash64<T: std::hash::Hash + ?Sized>(v: &T) -> u64 {
    let mut state = FxHasher64::default();
    v.hash(&mut state);
    state.finish()
}

/// A convenience function for when you need a quick 32-bit hash.
#[inline]
pub(crate) fn hash32<T: std::hash::Hash + ?Sized>(v: &T) -> u32 {
    let mut state = FxHasher32::default();
    v.hash(&mut state);
    state.finish() as u32
}

/// A convenience function for when you need a quick usize hash.
#[inline]
pub(crate) fn hash<T: std::hash::Hash + ?Sized>(v: &T) -> usize {
    let mut state = FxHasher::default();
    v.hash(&mut state);
    state.finish() as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fork ships the lockfile it was vendored with. Cargo ignores it —
    /// `patches/bm25` is a workspace member, so only the workspace lock is
    /// resolved — but every lockfile-based scanner reads it anyway (GitHub's
    /// dependency graph, dependabot, `cargo audit --file`). Leaving `fxhash
    /// 0.2.1` and its checksum in there keeps RUSTSEC-2025-0057 alive in the
    /// reports even though nothing links the crate any more.
    #[test]
    fn the_fork_no_longer_pins_the_unmaintained_fxhash_crate() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        for manifest in ["Cargo.toml", "Cargo.toml.orig", "Cargo.lock"] {
            let path = root.join(manifest);
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("{} is not readable: {e}", path.display()));
            assert!(
                !text.contains("fxhash"),
                "{manifest} still names fxhash; the algorithm is vendored in this file, \
                 so the dependency must not survive anywhere a scanner can read it"
            );
        }
    }

    /// Pinned against the real `fxhash` 0.2.1 crate (computed offline via a
    /// throwaway `cargo run` against the crates.io release, not derived from
    /// this vendored copy) so a future edit to this file cannot silently drift
    /// from the persisted algorithm that `content_index.rs` snapshots depend on.
    #[test]
    fn golden_vectors_match_upstream_fxhash_0_2_1() {
        let cases: &[(&str, &str, u32, u64, usize)] = &[
            (
                "empty",
                "",
                4209543787,
                3117886703346944619,
                3117886703346944619,
            ),
            (
                "len1",
                "a",
                119947305,
                12269146538841877247,
                12269146538841877247,
            ),
            (
                "len2",
                "ab",
                3219599024,
                10250694867308116139,
                10250694867308116139,
            ),
            (
                "len3",
                "abc",
                1861343345,
                15332822197660598287,
                15332822197660598287,
            ),
            (
                "len4",
                "abcd",
                1422747895,
                7348385130011000353,
                7348385130011000353,
            ),
            (
                "len5",
                "abcde",
                3270806634,
                16138393824342370871,
                16138393824342370871,
            ),
            (
                "len6",
                "abcdef",
                732210103,
                610042428198287682,
                610042428198287682,
            ),
            (
                "len7",
                "abcdefg",
                4120593889,
                17438866581258215047,
                17438866581258215047,
            ),
            (
                "len8plus",
                "abcdefghijklmnop",
                3262056058,
                13499320701897349564,
                13499320701897349564,
            ),
            (
                "nonascii",
                "héllo wörld 日本語",
                2159356355,
                7520523111874209656,
                7520523111874209656,
            ),
        ];

        for (label, input, expected32, expected64, expected_hash) in cases {
            assert_eq!(hash32(input), *expected32, "hash32 mismatch for {label}");
            assert_eq!(hash64(input), *expected64, "hash64 mismatch for {label}");
            // `hash()` uses the platform word size; this repo only targets
            // 64-bit hosts, where it is numerically identical to `hash64`.
            #[cfg(target_pointer_width = "64")]
            assert_eq!(hash(input), *expected_hash, "hash mismatch for {label}");
        }
    }
}

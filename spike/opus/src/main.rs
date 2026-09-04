//! T2 spike — native Opus encode via the `opus` crate (bundled libopus) + pure-Rust
//! OGG mux (`ogg` crate), replacing the ffmpeg subprocess shape (`-c:a libopus
//! -b:a 24k -f opus`). Throwaway; not in the workspace.
//!
//! Round-trip: synthetic 440 Hz sine (3 s, 16 kHz mono i16 — the Piper shape) →
//! WAV bytes → 20 ms Opus frames @ 24 kbps → OGG/Opus stream → demux → decode →
//! assert duration + frequency + amplitude. Run: `cargo run --release`.

use std::fs;
use std::io::Write;
use std::path::Path;

use ogg::{PacketReader, PacketWriteEndInfo, PacketWriter};
use opus::{Application, Bitrate, Channels};

const RATE: usize = 16_000;
const SECONDS: usize = 3;
const FREQ: f64 = 440.0;
const AMP: f64 = 0.4;

/// Canonical 44-byte mono-16-bit WAV around raw PCM (same shape as Piper output).
fn wav_bytes(pcm: &[i16]) -> Vec<u8> {
    let data_len = u32::try_from(pcm.len() * 2).unwrap();
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(RATE as u32).to_le_bytes());
    out.extend_from_slice(&((RATE * 2) as u32).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// OGG/Opus ID header. `input_rate` is advisory (all granule math is 48 kHz).
fn opus_head(preskip: u16, input_rate: u32) -> Vec<u8> {
    let mut h = Vec::with_capacity(19);
    h.extend_from_slice(b"OpusHead");
    h.push(1); // version
    h.push(1); // channels
    h.extend_from_slice(&preskip.to_le_bytes());
    h.extend_from_slice(&input_rate.to_le_bytes());
    h.extend_from_slice(&0i16.to_le_bytes()); // output gain
    h.push(0); // mapping family
    h
}

fn opus_tags(vendor: &str) -> Vec<u8> {
    let mut t = Vec::new();
    t.extend_from_slice(b"OpusTags");
    t.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    t.extend_from_slice(vendor.as_bytes());
    t.extend_from_slice(&0u32.to_le_bytes()); // zero comments
    t
}

/// Encode PCM into OGG/Opus container bytes.
fn encode_ogg(pcm: &[i16]) -> (Vec<u8>, usize) {
    let mut enc =
        opus::Encoder::new(RATE as u32, Channels::Mono, Application::Voip).expect("encoder create");
    enc.set_bitrate(Bitrate::Bits(24_000)).expect("bitrate 24k");
    // Lookahead is reported at 48 kHz (doc'd libopus semantics).
    let lookahead = enc.get_lookahead().expect("lookahead") as u16;

    let mut wtr = PacketWriter::new(Vec::new());
    let serial = 0x5412_0001u32;

    // Header page: OpusHead + OpusTags alone, then force a page break.
    wtr.write_packet(
        opus_head(lookahead, RATE as u32),
        serial,
        PacketWriteEndInfo::EndPage,
        0,
    )
    .expect("head packet");
    wtr.write_packet(
        opus_tags("taletrek-opus-spike"),
        serial,
        PacketWriteEndInfo::NormalPacket,
        0,
    )
    .expect("tags packet");

    // Audio: 20 ms frames (320 samples @16k = 960 granules @48k per frame).
    // Whole frames only; a partial tail is padded with silence. The LAST packet
    // must carry EndStream so the writer flushes the final page.
    const FRAME: usize = 320; // samples
    const GRAN_PER_FRAME: u64 = 960; // 48 kHz granules for 20 ms
    let mut frames: Vec<Vec<i16>> = pcm.chunks_exact(FRAME).map(<[i16]>::to_vec).collect();
    if let Some(tail_frame) = frames.last().filter(|f| f.len() < FRAME) {
        let mut padded = tail_frame.clone();
        padded.resize(FRAME, 0);
        let n = frames.len() - 1;
        frames[n] = padded;
    }
    let mut buf = vec![0u8; 4000];
    let mut granule = u64::from(lookahead);
    let packets = frames.len();
    for (i, frame) in frames.iter().enumerate() {
        let n = enc.encode(frame, &mut buf).expect("encode frame");
        let pkt = buf[..n].to_vec();
        granule += GRAN_PER_FRAME;
        let last = i + 1 == packets;
        let inf = if last {
            PacketWriteEndInfo::EndStream
        } else {
            PacketWriteEndInfo::NormalPacket
        };
        wtr.write_packet(pkt, serial, inf, granule)
            .expect("audio packet");
    }

    (wtr.into_inner(), packets)
}

/// Demux + decode the OGG/Opus bytes back to PCM; returns (samples, packets).
fn decode_ogg(bytes: &[u8]) -> (Vec<i16>, usize) {
    let mut rdr = PacketReader::new(std::io::Cursor::new(bytes));
    let mut dec = opus::Decoder::new(RATE as u32, Channels::Mono).expect("decoder create");
    let mut pcm = Vec::new();
    let mut packets = 0usize;
    let mut first = true;
    while let Some(pkt) = rdr.read_packet().expect("read packet") {
        if first {
            assert_eq!(&pkt.data[..8], b"OpusHead", "first packet is OpusHead");
            assert_eq!(pkt.data[8], 1, "head version");
            assert_eq!(pkt.data[9], 1, "head channels");
            let rate = u32::from_le_bytes(pkt.data[12..16].try_into().unwrap());
            assert_eq!(rate, RATE as u32, "head input rate");
            first = false;
            continue; // headers are not audio
        }
        if pkt.data.starts_with(b"OpusTags") {
            continue;
        }
        let mut out = vec![0i16; 5760]; // max frame at 16 kHz is 120 ms = 1920; slack ok
        let n = dec
            .decode(&pkt.data, &mut out, false)
            .expect("decode packet");
        pcm.extend_from_slice(&out[..n]);
        packets += 1;
    }
    (pcm, packets)
}

fn main() {
    println!("libopus: {}", opus::version());

    // 1. Synthetic source: 3 s of 440 Hz sine, mono 16 kHz i16.
    let total = RATE * SECONDS;
    let pcm: Vec<i16> = (0..total)
        .map(|i| {
            let t = i as f64 / RATE as f64;
            (AMP * (2.0 * std::f64::consts::PI * FREQ * t).sin() * 32767.0) as i16
        })
        .collect();
    let wav = wav_bytes(&pcm);
    println!("source: {total} samples, {} WAV bytes", wav.len());

    // 2. Encode → OGG/Opus.
    let (ogg_bytes, packets) = encode_ogg(&pcm);
    let kbps = ogg_bytes.len() as f64 * 8.0 / SECONDS as f64 / 1000.0;
    println!(
        "encoded: {packets} packets, {} OGG bytes (~{kbps:.0} kbps incl. container)",
        ogg_bytes.len()
    );

    let out_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("out");
    fs::create_dir_all(&out_dir).unwrap();
    fs::write(out_dir.join("spike.opus"), &ogg_bytes).unwrap();

    // Also drop the source WAV for the ffmpeg comparison step (shell-side).
    fs::write(out_dir.join("source.wav"), &wav).unwrap();

    // 3. Round-trip: demux + decode, assert shape.
    let (pcm2, packets2) = decode_ogg(&ogg_bytes);
    assert_eq!(packets2, packets, "packet count round-trips");
    let expect_lo = total.saturating_sub(RATE / 20); // ±50 ms
    let expect_hi = total + RATE / 20 + 3 * 320; // + lookahead/tail slack
    assert!(
        pcm2.len() >= expect_lo && pcm2.len() <= expect_hi,
        "decoded {} samples, expected ~{total} (±tail)",
        pcm2.len()
    );

    // 4. Audio sanity: amplitude close to source + zero-crossing frequency ≈ 440 Hz.
    let peak = pcm2.iter().map(|s| s.unsigned_abs()).max().unwrap();
    assert!(peak > 8_000, "decoded peak too low: {peak}");
    let crossings = pcm2.windows(2).filter(|w| (w[0] < 0) != (w[1] < 0)).count() as f64;
    let est_hz = crossings / 2.0 / (pcm2.len() as f64 / RATE as f64);
    let rel = (est_hz - FREQ) / FREQ;
    assert!(
        rel.abs() < 0.05,
        "decoded tone drifted: {est_hz:.1} Hz vs {FREQ}"
    );
    let rms = (pcm2
        .iter()
        .map(|s| {
            let v = f64::from(*s);
            v * v
        })
        .sum::<f64>()
        / pcm2.len() as f64)
        .sqrt();
    println!(
        "round-trip: {} samples decoded, peak {peak}, tone {est_hz:.1} Hz, RMS {rms:.0} — all asserts pass",
        pcm2.len()
    );

    // 5. Write decoded PCM back out as WAV for optional listening/ffprobe.
    let decoded_wav = wav_bytes(&pcm2);
    let mut f = fs::File::create(out_dir.join("decoded.wav")).unwrap();
    f.write_all(&decoded_wav).unwrap();

    println!("\nPASS: encode→OGG→decode round-trip verified in-crate");
    println!("next (shell): ffprobe out/spike.opus vs ffmpeg -c:a libopus output");
}

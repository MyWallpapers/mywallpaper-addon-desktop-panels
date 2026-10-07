use std::io::{self, Read, Write};

use serde_json::Value;

pub const MAX_PHYSICAL_CHUNK: usize = 1024 * 1024;
pub const MAX_LOGICAL_RECORD: usize = 8 * 1024 * 1024;
const LENGTH_MASK: u32 = 0x3fff_ffff;

/// Read one process-v2 record. The initial `init` record is a single chunk in
/// both supported protocol versions, so its version can be negotiated after
/// reading the first header.
pub fn read_json_record<R: Read>(
    reader: &mut R,
    version: Option<u32>,
) -> io::Result<Option<Value>> {
    let Some(header) = read_header(reader)? else {
        return Ok(None);
    };
    let version = version.unwrap_or(4);
    let mut record = Vec::new();

    match version {
        4 => append_chunk(reader, header as usize, &mut record)?,
        5 => {
            let mut kind = header >> 30;
            let mut length = (header & LENGTH_MASK) as usize;
            let mut started = false;
            loop {
                match kind {
                    0 if !started => {
                        append_chunk(reader, length, &mut record)?;
                        break;
                    }
                    0 => return Err(invalid_data("single chunk interrupted a record")),
                    1 if !started => {
                        append_chunk(reader, length, &mut record)?;
                        started = true;
                        (kind, length) = next_chunk_header(reader, "truncated chunk sequence")?;
                        if kind != 2 && kind != 3 {
                            return Err(invalid_data("invalid chunk sequence after start"));
                        }
                    }
                    2 if started => {
                        append_chunk(reader, length, &mut record)?;
                        (kind, length) =
                            next_chunk_header(reader, "truncated chunk sequence continuation")?;
                        if kind != 2 && kind != 3 {
                            return Err(invalid_data("invalid chunk sequence continuation"));
                        }
                    }
                    3 if started => {
                        append_chunk(reader, length, &mut record)?;
                        break;
                    }
                    1 => return Err(invalid_data("nested start chunk")),
                    2 | 3 => {
                        return Err(invalid_data("continuation chunk appeared without a start"));
                    }
                    _ => unreachable!(),
                }
            }
        }
        _ => return Err(invalid_data("unsupported process-v2 protocol version")),
    }

    serde_json::from_slice(&record)
        .map(Some)
        .map_err(|error| invalid_data(format!("invalid JSON record: {error}")))
}

pub fn write_json_record<W: Write>(writer: &mut W, version: u32, value: &Value) -> io::Result<()> {
    let record = serde_json::to_vec(value)
        .map_err(|error| invalid_data(format!("could not encode JSON record: {error}")))?;
    if record.is_empty() {
        return Err(invalid_data("JSON record cannot be empty"));
    }
    if record.len() > MAX_LOGICAL_RECORD {
        return Err(invalid_data("logical record exceeds the 8 MiB limit"));
    }

    match version {
        4 => {
            if record.len() > MAX_PHYSICAL_CHUNK {
                return Err(invalid_data("protocol v4 records must fit in one chunk"));
            }
            write_chunk(writer, 0, &record)?;
        }
        5 => {
            if record.len() <= MAX_PHYSICAL_CHUNK {
                write_chunk(writer, 0, &record)?;
            } else {
                let mut chunks = record.chunks(MAX_PHYSICAL_CHUNK).peekable();
                if let Some(first) = chunks.next() {
                    write_chunk(writer, 1, first)?;
                }
                while let Some(chunk) = chunks.next() {
                    let kind = if chunks.peek().is_none() { 3 } else { 2 };
                    write_chunk(writer, kind, chunk)?;
                }
            }
        }
        _ => return Err(invalid_data("unsupported process-v2 protocol version")),
    }
    writer.flush()
}

fn next_chunk_header<R: Read>(reader: &mut R, message: &str) -> io::Result<(u32, usize)> {
    let header = read_header(reader)?.ok_or_else(|| invalid_data(message))?;
    Ok((header >> 30, (header & LENGTH_MASK) as usize))
}

fn read_header<R: Read>(reader: &mut R) -> io::Result<Option<u32>> {
    let mut bytes = [0_u8; 4];
    match reader.read(&mut bytes[..1])? {
        0 => return Ok(None),
        1 => {}
        _ => unreachable!(),
    }
    reader.read_exact(&mut bytes[1..])?;
    Ok(Some(u32::from_le_bytes(bytes)))
}

fn append_chunk<R: Read>(reader: &mut R, length: usize, record: &mut Vec<u8>) -> io::Result<()> {
    if length == 0 || length > MAX_PHYSICAL_CHUNK {
        return Err(invalid_data(
            "physical chunk length must be between 1 byte and 1 MiB",
        ));
    }
    let new_length = record
        .len()
        .checked_add(length)
        .filter(|length| *length <= MAX_LOGICAL_RECORD)
        .ok_or_else(|| invalid_data("logical record exceeds the 8 MiB limit"))?;
    record
        .try_reserve(length)
        .map_err(|error| invalid_data(format!("could not reserve record memory: {error}")))?;
    let old_length = record.len();
    record.resize(new_length, 0);
    reader.read_exact(&mut record[old_length..])
}

fn write_chunk<W: Write>(writer: &mut W, kind: u32, chunk: &[u8]) -> io::Result<()> {
    if chunk.is_empty() || chunk.len() > MAX_PHYSICAL_CHUNK {
        return Err(invalid_data(
            "physical chunk length must be between 1 byte and 1 MiB",
        ));
    }
    let header = ((kind & 0b11) << 30) | chunk.len() as u32;
    writer.write_all(&header.to_le_bytes())?;
    writer.write_all(chunk)
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v4_uses_single_chunk_records() {
        let expected = serde_json::json!({"type":"init", "v":4});
        let mut bytes = Vec::new();
        write_json_record(&mut bytes, 4, &expected).unwrap();
        assert_eq!(
            read_json_record(&mut bytes.as_slice(), Some(4)).unwrap(),
            Some(expected)
        );
    }

    #[test]
    fn initial_v5_init_record_is_read_before_version_negotiation() {
        let expected = serde_json::json!({"type":"init", "v":5});
        let mut bytes = Vec::new();
        write_json_record(&mut bytes, 5, &expected).unwrap();
        assert_eq!(
            read_json_record(&mut bytes.as_slice(), None).unwrap(),
            Some(expected)
        );
    }

    #[test]
    fn v5_uses_ordered_continuation_chunks() {
        let expected = serde_json::json!({"payload":"x".repeat(MAX_PHYSICAL_CHUNK + 37)});
        let mut bytes = Vec::new();
        write_json_record(&mut bytes, 5, &expected).unwrap();
        assert_eq!(
            read_json_record(&mut bytes.as_slice(), Some(5)).unwrap(),
            Some(expected)
        );
    }

    #[test]
    fn rejects_oversized_physical_chunk_before_reserving_it() {
        let header = ((1_u32 << 30) | ((MAX_PHYSICAL_CHUNK + 1) as u32)).to_le_bytes();
        assert!(read_json_record(&mut header.as_slice(), Some(5)).is_err());
    }

    #[test]
    fn rejects_logical_record_over_eight_mib() {
        let mut bytes = Vec::new();
        let full = vec![b'x'; MAX_PHYSICAL_CHUNK];
        for kind in 0..8_u32 {
            let chunk_kind = if kind == 0 {
                1
            } else if kind == 7 {
                3
            } else {
                2
            };
            write_chunk(&mut bytes, chunk_kind, &full).unwrap();
        }
        write_chunk(&mut bytes, 3, b"x").unwrap();
        assert!(read_json_record(&mut bytes.as_slice(), Some(5)).is_err());
    }

    #[test]
    fn rejects_protocol_v4_records_that_exceed_one_chunk() {
        let value = serde_json::json!({"payload":"x".repeat(MAX_PHYSICAL_CHUNK)});
        let mut bytes = Vec::new();
        assert!(write_json_record(&mut bytes, 4, &value).is_err());
    }
}

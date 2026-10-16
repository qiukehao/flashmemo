//! Card image attachments (SPEC §5.4 / §9.4).
//!
//! Card markdown never stores paths to the user's disk. Images are copied into
//! `%APPDATA%\FlashMemo\attachments` under a content-addressed name and the
//! markdown keeps a stable `attachment:<file>` reference; the frontend resolves
//! that reference to an `asset:` URL at render time. Copying is best-effort:
//! a markdown ref we cannot resolve (missing file, remote URL) stays untouched
//! and the card shows a placeholder instead of a broken image.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Markdown reference scheme, e.g. `![图](attachment:ab12….png)`.
pub const SCHEME: &str = "attachment:";

/// Extensions we are willing to store/serve. Anything else is rejected rather
/// than copied into the attachment folder.
const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico",
];

/// `%APPDATA%\FlashMemo\attachments` (SPEC §14: user data stays under FlashMemo).
pub fn store_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|e| format!("APPDATA unavailable: {e}"))?;
    Ok(Path::new(&appdata).join("FlashMemo").join("attachments"))
}

/// True when `src` is one of our own attachment references.
pub fn is_attachment(src: &str) -> bool {
    src.starts_with(SCHEME)
}

/// Absolute path of an `attachment:<file>` reference, if it names a stored file.
pub fn path_of(dir: &Path, src: &str) -> Option<PathBuf> {
    let name = src.strip_prefix(SCHEME)?;
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return None;
    }
    let path = dir.join(name);
    path.is_file().then_some(path)
}

/// Store `bytes` as an image; returns the markdown reference to embed.
/// `ext_hint` (e.g. a clipboard mime type) is only used when the bytes do not
/// carry a recognizable magic number.
pub fn save_bytes(dir: &Path, bytes: &[u8], ext_hint: Option<&str>) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("图片内容为空".into());
    }
    let ext = sniff_ext(bytes)
        .or_else(|| ext_hint.and_then(sanitize_ext))
        .ok_or_else(|| "只支持图片文件（png / jpg / gif / webp / bmp / svg）".to_string())?;
    let name = format!("{}.{}", hash_hex(bytes), ext);
    let path = dir.join(&name);
    if !path.is_file() {
        std::fs::create_dir_all(dir).map_err(|e| format!("无法创建附件目录：{e}"))?;
        std::fs::write(&path, bytes).map_err(|e| format!("写入图片失败：{e}"))?;
    }
    Ok(format!("{SCHEME}{name}"))
}

/// Copy a picked file into the attachment store (extension from the file name
/// after checking the content really is an image).
pub fn save_file(dir: &Path, src: &Path) -> Result<String, String> {
    let bytes = std::fs::read(src).map_err(|e| format!("读取图片失败：{e}"))?;
    let hint = src.extension().and_then(|s| s.to_str());
    save_bytes(dir, &bytes, hint)
}

/// `data:image/png;base64,AAAA…` (FileReader / clipboard) -> bytes + mime hint.
pub fn parse_data_url(data: &str) -> Result<(Vec<u8>, Option<String>), String> {
    use base64::Engine;
    let (meta, payload) = data
        .split_once(',')
        .ok_or_else(|| "图片数据格式不正确".to_string())?;
    if !meta.starts_with("data:") {
        return Err("图片数据格式不正确".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("图片数据解码失败：{e}"))?;
    let mime = meta
        .strip_prefix("data:")
        .and_then(|m| m.split(';').next())
        .filter(|m| m.starts_with("image/"))
        .map(str::to_string);
    Ok((bytes, mime))
}

/// Rewrite local image references in one card's markdown so they point at the
/// attachment store, copying each file exactly once. `base` is the folder of
/// the source `.md` (relative refs resolve against it). References we cannot
/// resolve — missing files, `http(s):`, `data:`, existing attachments — are
/// left byte-for-byte alone.
pub fn rewrite_refs(md: &str, base: &Path, store: &Path) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for line in md.split('\n') {
        if let Some((c, n)) = crate::parser::fence_run(line) {
            if fence.is_some_and(|(oc, on)| oc == c && n >= on)
                && crate::parser::is_closing_fence(line, c, n)
            {
                fence = None;
            } else if fence.is_none() {
                fence = Some((c, n));
            }
            out.push(line.to_string());
            continue;
        }
        if fence.is_some() {
            out.push(line.to_string());
            continue;
        }
        out.push(rewrite_line(line, base, store));
    }
    out.join("\n")
}

/// One line of `rewrite_refs` — only `![alt](dest "title")` spans are touched.
fn rewrite_line(line: &str, base: &Path, store: &Path) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("![") {
        let after = &rest[start + 2..];
        let Some(alt_end) = after.find(']') else {
            break;
        };
        let (alt, tail) = after.split_at(alt_end);
        let Some(body) = tail.strip_prefix("](") else {
            out.push_str(&rest[..start + 2]);
            rest = after;
            continue;
        };
        let (dest, title, consumed) = match parse_destination(body) {
            Some(parsed) => parsed,
            None => {
                out.push_str(&rest[..start + 2]);
                rest = after;
                continue;
            }
        };
        out.push_str(&rest[..start]);
        match local_file(&dest, base) {
            Some(file) if is_image_path(&file) => match save_file(store, &file) {
                Ok(reference) => out.push_str(&format!("![{alt}]({reference}{title})")),
                Err(_) => out.push_str(&rest[start..start + 2 + alt_end + 2 + consumed]),
            },
            _ => out.push_str(&rest[start..start + 2 + alt_end + 2 + consumed]),
        }
        rest = &body[consumed..];
    }
    out.push_str(rest);
    out
}

/// Parse `dest)`, `<dest with spaces> "title")`, `dest "title")`. Returns the
/// destination, the raw title suffix (including leading space, if any) and how
/// many bytes of `body` were consumed (including the closing `)`).
fn parse_destination(body: &str) -> Option<(String, String, usize)> {
    if let Some(rest) = body.strip_prefix('<') {
        let end = rest.find('>')?;
        let dest = rest[..end].to_string();
        let after = &rest[end + 1..];
        let close = after.find(')')?;
        return Some((dest, after[..close].to_string(), end + 1 + close + 2));
    }
    let close = body.find(')')?;
    let inner = &body[..close];
    let (dest, title) = match inner.find(|c: char| c.is_whitespace()) {
        Some(i) => (inner[..i].to_string(), inner[i..].to_string()),
        None => (inner.to_string(), String::new()),
    };
    Some((dest, title, close + 1))
}

/// Resolve a markdown destination to an existing local file, or None for
/// anything we must not touch (`http:`, `data:`, our own refs, missing files).
fn local_file(dest: &str, base: &Path) -> Option<PathBuf> {
    let dest = dest.trim();
    if dest.is_empty() || dest.starts_with('#') || dest.contains(':') || dest.starts_with("//") {
        return None;
    }
    let decoded = percent_decode(dest);
    let path = Path::new(&decoded);
    let full = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    full.is_file().then_some(full)
}

fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

fn sanitize_ext(ext: &str) -> Option<&'static str> {
    // Accepts both `png` and `image/png` (clipboard mime types).
    let cleaned = ext
        .trim()
        .trim_start_matches('.')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    IMAGE_EXTS.iter().copied().find(|e| *e == cleaned)
}

/// Magic-number sniffing so pasted/renamed files still get a sane extension.
fn sniff_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("gif");
    }
    if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("bmp");
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]).to_ascii_lowercase();
    if head.contains("<svg") {
        return Some("svg");
    }
    None
}

fn hash_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// `%20` / Chinese characters in markdown destinations -> plain path text.
fn percent_decode(s: &str) -> String {
    let raw = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            let hex = std::str::from_utf8(&raw[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fm-attach-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
    const GIF: &[u8] = b"GIF89a\x01\x00\x01\x00\x80";

    #[test]
    fn names_are_content_addressed() {
        let store = temp_dir("name");
        let a = save_bytes(&store, PNG, None).unwrap();
        let b = save_bytes(&store, PNG, Some("image/png")).unwrap();
        let c = save_bytes(&store, GIF, None).unwrap();
        assert_eq!(a, b, "same bytes must map to the same file");
        assert_ne!(a, c);
        assert!(a.starts_with(SCHEME) && a.ends_with(".png"), "{a}");
        assert!(c.ends_with(".gif"), "{c}");
        assert!(path_of(&store, &a).is_some());
        assert_eq!(
            std::fs::read(store.join(a.trim_start_matches(SCHEME))).unwrap(),
            PNG
        );
        std::fs::remove_dir_all(&store).ok();
    }

    #[test]
    fn rejects_non_images() {
        let store = temp_dir("reject");
        assert!(save_bytes(&store, b"not an image", None).is_err());
        assert!(save_bytes(&store, b"", Some("image/png")).is_err());
        assert!(save_bytes(&store, b"plain text", Some("text/plain")).is_err());
        // Bytes we cannot sniff (avif) still get in through a trusted hint —
        // the picker/clipboard only ever hands us real image files.
        assert!(save_bytes(&store, b"\x00\x00\x00\x1cftypavif", Some("image/avif")).is_ok());
        std::fs::remove_dir_all(&store).ok();
    }

    #[test]
    fn data_url_roundtrip() {
        let (bytes, mime) = parse_data_url("data:image/png;base64,iVBORw0KGgo=").unwrap();
        assert_eq!(bytes, &PNG[..8]);
        assert_eq!(mime.as_deref(), Some("image/png"));
        assert!(parse_data_url("data:image/png;base64,!!").is_err());
        assert!(parse_data_url("just a string").is_err());
        // The mime hint from a data URL is usable as an extension directly.
        let store = temp_dir("dataurl");
        let saved = save_bytes(
            &store,
            &[0, 0, 0, 0x1c, b'f', b't', b'y', b'p'],
            mime.as_deref(),
        );
        assert!(saved.map(|s| s.ends_with(".png")).unwrap_or(false));
        std::fs::remove_dir_all(&store).ok();
    }

    #[test]
    fn rewrite_copies_relative_refs() {
        let root = temp_dir("rewrite");
        let md_dir = root.join("notes");
        std::fs::create_dir_all(md_dir.join("images")).unwrap();
        std::fs::write(md_dir.join("images/a.png"), PNG).unwrap();
        std::fs::write(md_dir.join("b.gif"), GIF).unwrap();
        let store = root.join("store");

        let md = "图一：\n\n![示意图](<images/a.png>)\n\n![动图](b.gif \"标题\")\n\n\
                  ![带空格](<images/a.png>)\n\n![缺失](images/missing.png)\n\n\
                  ![远程](https://example.com/x.png)\n\n![已存](attachment:deadbeef.png)\n\n\
                  ```\n![示例](images/a.png)\n```\n"
            .to_string();
        let out = rewrite_refs(&md, &md_dir, &store);
        let name_a = save_bytes(&store, PNG, None).unwrap();
        let name_b = save_bytes(&store, GIF, None).unwrap();
        assert!(out.contains(&format!("![示意图]({name_a})")), "{out}");
        assert!(
            out.contains(&format!("![动图]({name_b} \"标题\")")),
            "{out}"
        );
        assert!(out.contains("![缺失](images/missing.png)"), "{out}");
        assert!(out.contains("![远程](https://example.com/x.png)"), "{out}");
        assert!(out.contains("![已存](attachment:deadbeef.png)"), "{out}");
        assert!(
            out.contains("```\n![示例](images/a.png)\n```"),
            "fenced code must not be rewritten:\n{out}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rewrite_decodes_percent_escapes() {
        let root = temp_dir("percent");
        let md_dir = root.join("docs");
        std::fs::create_dir_all(&md_dir).unwrap();
        std::fs::write(md_dir.join("截屏 2026.png"), PNG).unwrap();
        let store = root.join("store");
        let md = "![截屏](<%E6%88%AA%E5%B1%8F%202026.png>)\n";
        let out = rewrite_refs(md, &md_dir, &store);
        assert!(out.contains("attachment:") && !out.contains("%E6"), "{out}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn attachment_paths_stay_inside_the_store() {
        let store = temp_dir("escape");
        std::fs::write(store.join("ok.png"), PNG).unwrap();
        assert!(path_of(&store, "attachment:ok.png").is_some());
        assert!(path_of(&store, "attachment:../ok.png").is_none());
        assert!(path_of(&store, "attachment:sub/ok.png").is_none());
        assert!(path_of(&store, &format!("attachment:{}", "x".repeat(300))).is_none());
        assert!(path_of(&store, "attachment:nope.png").is_none());
        assert!(!is_attachment("images/a.png"));
        std::fs::remove_dir_all(&store).ok();
    }
}

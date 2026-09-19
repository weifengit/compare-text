// compare-text 桌面端 Rust 侧。
// 契约与 serve.js 的 /api/* 保持一致，供 src/source-api.js 在 Tauri 模式下调用：
//   api_list(path)      → { ok, path, dirs:[name], files:[{name,size,ext}] }
//   api_browse(path)    → { ok, path, parent, kind, dirs:[{name,path}] }
//   api_read_file(path) → 原始字节（前端转 Blob URL 给 pdf.js / fetch 使用）

use serde_json::json;

#[derive(serde::Serialize)]
struct FileInfo {
    name: String,
    size: u64,
    ext: String,
}

#[derive(serde::Serialize)]
struct DirInfo {
    name: String,
    path: String,
}

/// 列出目录下的子文件夹（带完整路径），按名称排序；Windows 下跳过系统保留目录（同 serve.js）。
fn list_dirs(p: &str, is_win: bool) -> std::io::Result<Vec<DirInfo>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(p)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if is_win && (name == "System Volume Information" || name == "$RECYCLE.BIN") {
            continue;
        }
        out.push(DirInfo {
            path: std::path::Path::new(p).join(&name).to_string_lossy().into_owned(),
            name,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Windows 盘符列表（逐个字母探测存在的驱动器），供空路径浏览时返回；其他平台不可用。
fn list_drives() -> Vec<DirInfo> {
    let mut out = Vec::new();
    for l in 'A'..='Z' {
        let root = format!("{}:\\", l);
        if std::path::Path::new(&root).exists() {
            out.push(DirInfo { name: format!("{}:", l), path: root });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 上一级目录；'' 表示无上级（系统根 / 盘符根），此时由前端回落到根或盘符列表。
fn parent_of(resolved: &str, is_win: bool) -> String {
    if is_win {
        // 盘符根（C:\ / C:/ / C:）→ 无上级
        let b = resolved.as_bytes();
        let drive_root = b.len() == 2 && b[1] == b':'
            || b.len() == 3 && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
        if drive_root {
            return String::new();
        }
    }
    if resolved == "/" {
        return String::new();
    }
    match std::path::Path::new(resolved).parent() {
        Some(parent) => parent.to_string_lossy().into_owned(),
        None => String::new(),
    }
}

/// 目录列表：同 serve.js 的 GET /api/list。
#[tauri::command]
fn api_list(path: String) -> Result<serde_json::Value, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| format!("{}: {}", path, e))?;
    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<FileInfo> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            dirs.push(name);
        } else if ft.is_file() {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let ext = std::path::Path::new(&name)
                .extension()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            files.push(FileInfo { name, size, ext });
        }
    }
    dirs.sort();
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(json!({ "ok": true, "path": path, "dirs": dirs, "files": files }))
}

/// 目录浏览：同 serve.js 的 GET /api/browse（文件夹选择弹层用）。
#[tauri::command]
fn api_browse(path: String) -> Result<serde_json::Value, String> {
    let is_win = std::env::consts::OS == "windows";
    let p = path.trim().to_string();
    if p.is_empty() || p == "/" || p == "\\" {
        if is_win {
            return Ok(json!({ "ok": true, "path": "", "parent": "", "kind": "drives", "dirs": list_drives() }));
        }
        let dirs = list_dirs("/", false).map_err(|e| e.to_string())?;
        return Ok(json!({ "ok": true, "path": "/", "parent": "", "kind": "dir", "dirs": dirs }));
    }
    let meta = std::fs::metadata(&p).map_err(|_| format!("目录不存在：{}", p))?;
    if !meta.is_dir() {
        return Err(format!("目录不存在：{}", p));
    }
    let abs = std::path::absolute(&p)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let dirs = list_dirs(&abs, is_win).map_err(|e| e.to_string())?;
    let parent = parent_of(&abs, is_win);
    Ok(json!({ "ok": true, "path": abs, "parent": parent, "kind": "dir", "dirs": dirs }))
}

/// 读取文件字节：同 serve.js 的 GET /api/file（前端转 Blob URL）。
#[tauri::command]
fn api_read_file(path: String) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(&path).map_err(|_| "文件不存在".to_string())?;
    if !meta.is_file() {
        return Err("文件不存在".to_string());
    }
    std::fs::read(&path).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![api_list, api_browse, api_read_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

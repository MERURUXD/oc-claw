use std::process::Command;

fn main() {
    let sha = std::env::var("GITHUB_SHA")
        .or_else(|_| std::env::var("OC_CLAW_GIT_SHA"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "unknown".into());

    println!("cargo:rustc-env=OC_CLAW_GIT_SHA={sha}");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rerun-if-env-changed=OC_CLAW_GIT_SHA");
    // frontend/src-tauri -> repo root is ../..
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    tauri_build::build()
}

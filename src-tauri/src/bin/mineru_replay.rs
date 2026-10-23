//! MinerU 真实产物离线回放 CLI 入口（纯本地，不联网、不读凭据）
//!
//! 用法：
//!   cargo run --manifest-path src-tauri/Cargo.toml --bin mineru_replay -- <原始分册目录> <输出根目录>
//!
//! 示例：
//!   cargo run --manifest-path src-tauri/Cargo.toml --bin mineru_replay -- \
//!     "D:/path/to/extracted/part07" "D:/path/to/FlowRead/.mineru-replay"
//!
//! 输出：
//!   <输出根目录>/<part_name>/normalized/{blocks.json, content.md, assets/}
//!   <输出根目录>/<part_name>/workspace/  （隔离的隐式工作区导入副本）
//!   <输出根目录>/<part_name>/replay.db   （回放专用临时数据库）
//!   <输出根目录>/<part_name>/replay-report.{json,md}
//!
//! 退出码：0 全部校验通过；2 回放完成但存在未通过校验项；1 回放过程错误。

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!(
            "用法: {} <原始分册目录> <输出根目录>\n\
             说明: 纯离线回放，不联网、不读凭据；原始目录只读。",
            args.first().map(|s| s.as_str()).unwrap_or("mineru_replay")
        );
        return ExitCode::from(1);
    }

    let raw_dir = PathBuf::from(&args[1]);
    let out_root = PathBuf::from(&args[2]);

    match flowread_lib::mineru_replay::run_and_report(&raw_dir, &out_root) {
        Ok((report, json_path, md_path)) => {
            println!("=== MinerU 离线回放完成 ===");
            println!("输入: {} ({} 页 / {} 块 / {})", report.input_dir, report.input_pages, report.input_blocks, report.content_list_format);
            println!("输出: {} 块", report.output_blocks);
            println!("隔离工作区: {}", report.workspace_doc_dir);
            println!("预览入口(打开解析结果预览可用): {}", report.preview_blocks_path);
            println!("报告: {}", md_path.display());
            println!("      {}", json_path.display());
            println!();
            for check in &report.checks {
                println!(
                    "[{}] {} - {}",
                    if check.passed { "PASS" } else { "FAIL" },
                    check.name,
                    check.details
                );
            }
            if !report.normalization_warnings.is_empty() {
                println!();
                println!("归一化警告:");
                for w in &report.normalization_warnings {
                    println!("  - {}", w);
                }
            }
            println!();
            println!("总体结果: {}", if report.overall_pass { "通过" } else { "存在未通过校验项" });
            if report.overall_pass {
                ExitCode::from(0)
            } else {
                ExitCode::from(2)
            }
        }
        Err(e) => {
            eprintln!("回放失败: {}", e);
            ExitCode::from(1)
        }
    }
}

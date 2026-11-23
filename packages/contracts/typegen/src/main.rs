use std::env;
use std::fs;
use std::path::Path;

const OUTPUT_PATH: &str = "packages/contracts/wire.generated.ts";

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("usage: mise run generate:contracts [--check|--stdout]");
        return;
    }
    if args
        .iter()
        .any(|arg| !matches!(arg.as_str(), "--check" | "--stdout"))
    {
        eprintln!("unknown argument; use --check, --stdout, or --help");
        std::process::exit(2);
    }

    let generated = typegen::generated_wire_typescript();
    if args.iter().any(|arg| arg == "--stdout") {
        print!("{generated}");
        return;
    }
    if args.iter().any(|arg| arg == "--check") {
        check_generated(OUTPUT_PATH, &generated);
        return;
    }
    write_generated(OUTPUT_PATH, &generated);
}

fn check_generated(path: &str, generated: &str) {
    let current = fs::read_to_string(path).unwrap_or_default();
    if current != generated {
        eprintln!("{path} is stale; run `mise run generate:contracts`");
        std::process::exit(1);
    }
}

fn write_generated(path: &str, generated: &str) {
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create generated output directory");
    }
    if fs::read_to_string(path).ok().as_deref() == Some(generated) {
        return;
    }
    fs::write(path, generated).expect("write generated output");
    println!("wrote {}", path.display());
}

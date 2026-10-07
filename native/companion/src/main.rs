fn main() {
    if let Err(error) = desktop_panels::run() {
        eprintln!("desktop panels companion: {error}");
        std::process::exit(1);
    }
}

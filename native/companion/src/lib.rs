mod protocol;
mod validation;

#[cfg(windows)]
mod windows_runtime;

pub fn run() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_runtime::run()
    }
    #[cfg(not(windows))]
    {
        Err("The Desktop Panels companion is supported only on Windows.".to_owned())
    }
}

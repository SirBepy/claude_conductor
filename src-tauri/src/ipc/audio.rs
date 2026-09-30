use tauri_kit_audio::AudioOutputDevice;

/// Enumerate system audio output devices. Thin Tauri command over the kit's
/// `tauri_kit_audio::list_audio_output_devices` (keeps authorization via
/// `generate_handler`, no plugin ACL needed).
#[tauri::command]
pub async fn list_audio_output_devices() -> Vec<AudioOutputDevice> {
    tauri_kit_audio::list_audio_output_devices()
}

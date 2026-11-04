use rodio::cpal::traits::HostTrait;
use rodio::{DeviceSinkBuilder, DeviceTrait, MixerDeviceSink};

/// Resolve an output device by name, falling back to default.
pub fn resolve_output_stream(device_name: Option<&str>) -> Option<MixerDeviceSink> {
    if let Some(name) = device_name {
        let host = rodio::cpal::default_host();
        let device = host.output_devices().ok()?.find(|d| {
            d.description()
                .map(|description| description.name() == name)
                .unwrap_or(false)
        });
        if let Some(dev) = device {
            match DeviceSinkBuilder::from_device(dev).and_then(|builder| builder.open_stream()) {
                Ok(stream) => return Some(stream),
                Err(e) => {
                    tracing::warn!(
                        source = "notification_sound",
                        device = name,
                        "Failed to open selected device, falling back to default: {e}"
                    );
                }
            }
        } else {
            tracing::warn!(
                source = "notification_sound",
                device = name,
                "Configured device not found, falling back to default"
            );
        }
    }
    DeviceSinkBuilder::open_default_sink().ok()
}

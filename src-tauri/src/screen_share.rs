use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use image::codecs::jpeg::JpegEncoder;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_tungstenite::{accept_async, tungstenite::Message};
use xcap::Monitor;

static SERVER_RUNNING: AtomicBool = AtomicBool::new(false);

pub struct ScreenServer {
    shutdown_tx: Option<broadcast::Sender<()>>,
}

impl ScreenServer {
    pub fn new() -> Self {
        Self { shutdown_tx: None }
    }
}

lazy_static::lazy_static! {
    static ref SCREEN_SERVER: Arc<tokio::sync::Mutex<ScreenServer>> =
        Arc::new(tokio::sync::Mutex::new(ScreenServer::new()));
}

fn capture_screen_base64(quality: u8) -> Result<String, String> {
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let monitor = monitors.first().ok_or("No monitor found")?;

    let img = monitor.capture_image().map_err(|e| e.to_string())?;

    // Resize để giảm bandwidth (50% kích thước)
    let resized = image::imageops::resize(
        &img,
        img.width() / 2,
        img.height() / 2,
        image::imageops::FilterType::Triangle,
    );

    // Encode JPEG
    let mut buffer = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut buffer, quality);
    encoder
        .encode_image(&resized)
        .map_err(|e| e.to_string())?;

    Ok(STANDARD.encode(buffer.into_inner()))
}

async fn handle_client(stream: TcpStream, mut shutdown_rx: broadcast::Receiver<()>) {
    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(_) => return,
    };

    let (mut write, mut read) = ws_stream.split();

    // Gửi frame liên tục
    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => break,
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
                    match capture_screen_base64(50) {
                        Ok(frame) => {
                            if write.send(Message::Text(frame)).await.is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    });

    // Đọc message từ client (để detect disconnect)
    while let Some(msg) = read.next().await {
        if msg.is_err() {
            break;
        }
    }

    send_task.abort();
}

#[tauri::command]
pub async fn start_screen_server(port: u16) -> Result<String, String> {
    if SERVER_RUNNING.load(Ordering::SeqCst) {
        return Err("Server already running".to_string());
    }

    let listener = TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .map_err(|e| e.to_string())?;

    let (shutdown_tx, _) = broadcast::channel::<()>(1);
    let shutdown_tx_clone = shutdown_tx.clone();

    {
        let mut server = SCREEN_SERVER.lock().await;
        server.shutdown_tx = Some(shutdown_tx);
    }

    SERVER_RUNNING.store(true, Ordering::SeqCst);

    let local_ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "0.0.0.0".to_string());

    // Spawn server task
    tokio::spawn(async move {
        let mut shutdown_rx = shutdown_tx_clone.subscribe();
        loop {
            tokio::select! {
                result = listener.accept() => {
                    if let Ok((stream, _)) = result {
                        let client_shutdown_rx = shutdown_tx_clone.subscribe();
                        tokio::spawn(handle_client(stream, client_shutdown_rx));
                    }
                }
                _ = shutdown_rx.recv() => {
                    break;
                }
            }
        }
        SERVER_RUNNING.store(false, Ordering::SeqCst);
    });

    Ok(format!("{}:{}", local_ip, port))
}

#[tauri::command]
pub async fn stop_screen_server() -> Result<(), String> {
    let mut server = SCREEN_SERVER.lock().await;
    if let Some(tx) = server.shutdown_tx.take() {
        let _ = tx.send(());
    }
    SERVER_RUNNING.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn is_server_running() -> bool {
    SERVER_RUNNING.load(Ordering::SeqCst)
}

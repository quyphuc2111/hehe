use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex, RwLock};
use tokio_tungstenite::{accept_async, tungstenite::Message};

static SIGNALING_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
enum SignalMessage {
    #[serde(rename = "host")]
    Host { room: String },
    #[serde(rename = "viewer")]
    Viewer { room: String },
    #[serde(rename = "offer")]
    Offer {
        #[serde(rename = "viewerId")]
        viewer_id: String,
        sdp: String,
    },
    #[serde(rename = "answer")]
    Answer {
        #[serde(rename = "viewerId")]
        viewer_id: Option<String>,
        sdp: String,
    },
    #[serde(rename = "ice-candidate")]
    IceCandidate {
        #[serde(rename = "viewerId")]
        viewer_id: Option<String>,
        candidate: serde_json::Value,
    },
    #[serde(rename = "viewer-joined")]
    ViewerJoined {
        #[serde(rename = "viewerId")]
        viewer_id: String,
    },
    #[serde(rename = "viewer-left")]
    ViewerLeft {
        #[serde(rename = "viewerId")]
        viewer_id: String,
    },
    #[serde(rename = "host-left")]
    HostLeft,
    #[serde(rename = "error")]
    Error { message: String },
}

type Tx = tokio::sync::mpsc::UnboundedSender<Message>;

struct Room {
    host_tx: Option<Tx>,
    viewers: HashMap<String, Tx>,
}

lazy_static::lazy_static! {
    static ref ROOMS: Arc<RwLock<HashMap<String, Room>>> = Arc::new(RwLock::new(HashMap::new()));
    static ref SHUTDOWN_TX: Arc<Mutex<Option<broadcast::Sender<()>>>> = Arc::new(Mutex::new(None));
}

async fn handle_connection(stream: TcpStream, mut shutdown_rx: broadcast::Receiver<()>) {
    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(_) => return,
    };

    let (mut ws_tx, mut ws_rx) = ws_stream.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();

    let mut room_code: Option<String> = None;
    let mut is_host = false;
    let mut viewer_id: Option<String> = None;

    // Task gửi message
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Nhận message
    loop {
        tokio::select! {
            _ = shutdown_rx.recv() => break,
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(signal) = serde_json::from_str::<SignalMessage>(&text) {
                            match signal {
                                SignalMessage::Host { room } => {
                                    let mut rooms = ROOMS.write().await;
                                    rooms.insert(room.clone(), Room {
                                        host_tx: Some(tx.clone()),
                                        viewers: HashMap::new(),
                                    });
                                    room_code = Some(room);
                                    is_host = true;
                                }
                                SignalMessage::Viewer { room } => {
                                    let mut rooms = ROOMS.write().await;
                                    if let Some(r) = rooms.get_mut(&room) {
                                        let vid = uuid::Uuid::new_v4().to_string();
                                        r.viewers.insert(vid.clone(), tx.clone());
                                        viewer_id = Some(vid.clone());
                                        room_code = Some(room);

                                        // Thông báo host
                                        if let Some(host_tx) = &r.host_tx {
                                            let msg = SignalMessage::ViewerJoined { viewer_id: vid };
                                            let _ = host_tx.send(Message::Text(serde_json::to_string(&msg).unwrap()));
                                        }
                                    } else {
                                        let msg = SignalMessage::Error { message: "Room not found".to_string() };
                                        let _ = tx.send(Message::Text(serde_json::to_string(&msg).unwrap()));
                                    }
                                }
                                SignalMessage::Offer { viewer_id: vid, sdp } => {
                                    if let Some(ref room) = room_code {
                                        let rooms = ROOMS.read().await;
                                        if let Some(r) = rooms.get(room) {
                                            if let Some(viewer_tx) = r.viewers.get(&vid) {
                                                let msg = SignalMessage::Offer { viewer_id: vid, sdp };
                                                let _ = viewer_tx.send(Message::Text(serde_json::to_string(&msg).unwrap()));
                                            }
                                        }
                                    }
                                }
                                SignalMessage::Answer { viewer_id: _, sdp } => {
                                    if let Some(ref room) = room_code {
                                        if let Some(ref vid) = viewer_id {
                                            let rooms = ROOMS.read().await;
                                            if let Some(r) = rooms.get(room) {
                                                if let Some(host_tx) = &r.host_tx {
                                                    let msg = SignalMessage::Answer { viewer_id: Some(vid.clone()), sdp };
                                                    let _ = host_tx.send(Message::Text(serde_json::to_string(&msg).unwrap()));
                                                }
                                            }
                                        }
                                    }
                                }
                                SignalMessage::IceCandidate { viewer_id: target_vid, candidate } => {
                                    if let Some(ref room) = room_code {
                                        let rooms = ROOMS.read().await;
                                        if let Some(r) = rooms.get(room) {
                                            if is_host {
                                                // Host gửi cho viewer
                                                if let Some(vid) = target_vid {
                                                    if let Some(viewer_tx) = r.viewers.get(&vid) {
                                                        let msg = SignalMessage::IceCandidate { viewer_id: Some(vid), candidate };
                                                        let _ = viewer_tx.send(Message::Text(serde_json::to_string(&msg).unwrap()));
                                                    }
                                                }
                                            } else {
                                                // Viewer gửi cho host
                                                if let Some(host_tx) = &r.host_tx {
                                                    let msg = SignalMessage::IceCandidate { viewer_id: viewer_id.clone(), candidate };
                                                    let _ = host_tx.send(Message::Text(serde_json::to_string(&msg).unwrap()));
                                                }
                                            }
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    // Cleanup
    if let Some(room) = room_code {
        let mut rooms = ROOMS.write().await;
        if is_host {
            if let Some(r) = rooms.get(&room) {
                for (_, viewer_tx) in &r.viewers {
                    let msg = SignalMessage::HostLeft;
                    let _ = viewer_tx.send(Message::Text(serde_json::to_string(&msg).unwrap()));
                }
            }
            rooms.remove(&room);
        } else if let Some(vid) = viewer_id {
            if let Some(r) = rooms.get_mut(&room) {
                r.viewers.remove(&vid);
                if let Some(host_tx) = &r.host_tx {
                    let msg = SignalMessage::ViewerLeft { viewer_id: vid };
                    let _ = host_tx.send(Message::Text(serde_json::to_string(&msg).unwrap()));
                }
            }
        }
    }

    send_task.abort();
}

#[tauri::command]
pub async fn start_signaling_server(port: u16) -> Result<u16, String> {
    if SIGNALING_RUNNING.load(Ordering::SeqCst) {
        return Ok(port);
    }

    let listener = TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .map_err(|e| e.to_string())?;

    let (shutdown_tx, _) = broadcast::channel::<()>(1);
    {
        let mut tx = SHUTDOWN_TX.lock().await;
        *tx = Some(shutdown_tx.clone());
    }

    SIGNALING_RUNNING.store(true, Ordering::SeqCst);

    tokio::spawn(async move {
        let mut shutdown_rx = shutdown_tx.subscribe();
        loop {
            tokio::select! {
                result = listener.accept() => {
                    if let Ok((stream, _)) = result {
                        let client_shutdown_rx = shutdown_tx.subscribe();
                        tokio::spawn(handle_connection(stream, client_shutdown_rx));
                    }
                }
                _ = shutdown_rx.recv() => break,
            }
        }
        SIGNALING_RUNNING.store(false, Ordering::SeqCst);
    });

    Ok(port)
}

#[tauri::command]
pub async fn stop_signaling_server() -> Result<(), String> {
    let mut tx = SHUTDOWN_TX.lock().await;
    if let Some(shutdown_tx) = tx.take() {
        let _ = shutdown_tx.send(());
    }
    SIGNALING_RUNNING.store(false, Ordering::SeqCst);
    
    // Clear rooms
    let mut rooms = ROOMS.write().await;
    rooms.clear();
    
    Ok(())
}

import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface HostInfo {
  ip: string;
  hostname: string | null;
  source: string;
}

type Mode = "home" | "server" | "client" | "webrtc-host" | "webrtc-view" | "scanner";

function App() {
  const [mode, setMode] = useState<Mode>("home");

  return (
    <main className="container">
      {mode === "home" && <HomeScreen setMode={setMode} />}
      {mode === "server" && <ServerScreen setMode={setMode} />}
      {mode === "client" && <ClientScreen setMode={setMode} />}
      {mode === "webrtc-host" && <WebRTCHostScreen setMode={setMode} />}
      {mode === "webrtc-view" && <WebRTCViewScreen setMode={setMode} />}
      {mode === "scanner" && <ScannerScreen setMode={setMode} />}
    </main>
  );
}

function HomeScreen({ setMode }: { setMode: (m: Mode) => void }) {
  return (
    <div className="home">
      <h1>🖥️ Screen Share</h1>
      <p className="subtitle">Chia sẻ màn hình qua mạng LAN</p>
      
      <div className="method-section">
        <h3>WebSocket (JPEG Stream)</h3>
        <div className="home-buttons">
          <button onClick={() => setMode("server")} className="btn-primary">
            📡 Chia sẻ màn hình
          </button>
          <button onClick={() => setMode("client")} className="btn-secondary">
            👁️ Xem màn hình
          </button>
        </div>
      </div>

      <div className="method-section">
        <h3>WebRTC (Chất lượng cao)</h3>
        <div className="home-buttons">
          <button onClick={() => setMode("webrtc-host")} className="btn-primary">
            📡 Chia sẻ (WebRTC)
          </button>
          <button onClick={() => setMode("webrtc-view")} className="btn-secondary">
            👁️ Xem (WebRTC)
          </button>
        </div>
      </div>

      <div className="method-section">
        <button onClick={() => setMode("scanner")} className="btn-outline">
          🔍 Quét mạng LAN
        </button>
      </div>
    </div>
  );
}

// WebRTC Host - Chia sẻ màn hình
function WebRTCHostScreen({ setMode }: { setMode: (m: Mode) => void }) {
  const [isSharing, setIsSharing] = useState(false);
  const [roomCode, setRoomCode] = useState("");
  const [serverIp, setServerIp] = useState("");
  const [error, setError] = useState("");
  const [viewerCount, setViewerCount] = useState(0);
  
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  async function startSharing() {
    try {
      setError("");
      
      // Capture màn hình
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false
      });
      
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      // Kết nối signaling server
      const ip = await invoke<string>("get_local_ip");
      const signalingPort = await invoke<number>("start_signaling_server", { port: 9001 });
      
      setServerIp(ip);
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      setRoomCode(code);

      const ws = new WebSocket(`ws://${ip}:${signalingPort}`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "host", room: code }));
        setIsSharing(true);
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        
        if (msg.type === "viewer-joined") {
          // Tạo peer connection cho viewer mới
          const pc = createPeerConnection(msg.viewerId, ws);
          pcRef.current.set(msg.viewerId, pc);
          
          // Thêm tracks
          stream.getTracks().forEach(track => {
            pc.addTrack(track, stream);
          });

          // Tạo offer
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          
          ws.send(JSON.stringify({
            type: "offer",
            viewerId: msg.viewerId,
            sdp: offer.sdp
          }));
          
          setViewerCount(prev => prev + 1);
        }
        
        if (msg.type === "answer") {
          const pc = pcRef.current.get(msg.viewerId);
          if (pc) {
            await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          }
        }
        
        if (msg.type === "ice-candidate") {
          const pc = pcRef.current.get(msg.viewerId);
          if (pc && msg.candidate) {
            await pc.addIceCandidate(msg.candidate);
          }
        }

        if (msg.type === "viewer-left") {
          const pc = pcRef.current.get(msg.viewerId);
          if (pc) {
            pc.close();
            pcRef.current.delete(msg.viewerId);
            setViewerCount(prev => Math.max(0, prev - 1));
          }
        }
      };

      // Khi user dừng share từ browser
      stream.getVideoTracks()[0].onended = () => {
        stopSharing();
      };

    } catch (e) {
      setError(String(e));
    }
  }

  function createPeerConnection(viewerId: string, ws: WebSocket): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        ws.send(JSON.stringify({
          type: "ice-candidate",
          viewerId,
          candidate: event.candidate
        }));
      }
    };

    return pc;
  }

  function stopSharing() {
    streamRef.current?.getTracks().forEach(track => track.stop());
    pcRef.current.forEach(pc => pc.close());
    pcRef.current.clear();
    wsRef.current?.close();
    invoke("stop_signaling_server");
    setIsSharing(false);
    setRoomCode("");
    setViewerCount(0);
  }

  useEffect(() => {
    return () => {
      stopSharing();
    };
  }, []);

  return (
    <div className="screen-mode">
      <button className="back-btn" onClick={() => { stopSharing(); setMode("home"); }}>
        ← Quay lại
      </button>
      <h1>📡 WebRTC Screen Share</h1>

      {!isSharing ? (
        <button onClick={startSharing} className="btn-primary">
          Bắt đầu chia sẻ
        </button>
      ) : (
        <>
          <div className="server-info">
            <p>Mã phòng:</p>
            <code className="room-code">{roomCode}</code>
            <p className="hint">Server: {serverIp}:9001</p>
            <p className="viewer-count">👥 {viewerCount} người đang xem</p>
          </div>
          
          <div className="preview">
            <video ref={videoRef} autoPlay muted playsInline />
          </div>
          
          <button onClick={stopSharing} className="btn-danger">
            Dừng chia sẻ
          </button>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}

// WebRTC Viewer - Xem màn hình
function WebRTCViewScreen({ setMode }: { setMode: (m: Mode) => void }) {
  const [serverIp, setServerIp] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  async function connect() {
    if (!serverIp || !roomCode) return;
    
    setError("");
    
    const ws = new WebSocket(`ws://${serverIp}`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "viewer", room: roomCode.toUpperCase() }));
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "error") {
        setError(msg.message);
        return;
      }

      if (msg.type === "offer") {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        });
        pcRef.current = pc;

        pc.ontrack = (event) => {
          if (videoRef.current) {
            videoRef.current.srcObject = event.streams[0];
          }
          setConnected(true);
        };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            ws.send(JSON.stringify({
              type: "ice-candidate",
              candidate: event.candidate
            }));
          }
        };

        await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        ws.send(JSON.stringify({
          type: "answer",
          sdp: answer.sdp
        }));
      }

      if (msg.type === "ice-candidate" && msg.candidate) {
        await pcRef.current?.addIceCandidate(msg.candidate);
      }

      if (msg.type === "host-left") {
        setError("Host đã ngắt kết nối");
        disconnect();
      }
    };

    ws.onerror = () => {
      setError("Không thể kết nối đến server");
    };
  }

  function disconnect() {
    pcRef.current?.close();
    wsRef.current?.close();
    setConnected(false);
  }

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, []);

  return (
    <div className="screen-mode">
      <button className="back-btn" onClick={() => { disconnect(); setMode("home"); }}>
        ← Quay lại
      </button>
      <h1>👁️ WebRTC Viewer</h1>

      {!connected ? (
        <div className="connect-form">
          <input
            type="text"
            placeholder="Server IP:Port (vd: 192.168.1.5:9001)"
            value={serverIp}
            onChange={(e) => setServerIp(e.target.value)}
          />
          <input
            type="text"
            placeholder="Mã phòng"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
            maxLength={6}
          />
          <button onClick={connect} className="btn-primary">
            Kết nối
          </button>
        </div>
      ) : (
        <>
          <div className="viewer">
            <video ref={videoRef} autoPlay playsInline />
          </div>
          <button onClick={disconnect} className="btn-danger">
            Ngắt kết nối
          </button>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}

function ServerScreen({ setMode }: { setMode: (m: Mode) => void }) {
  const [serverAddress, setServerAddress] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");

  async function startServer() {
    try {
      setError("");
      const address = await invoke<string>("start_screen_server", { port: 9000 });
      setServerAddress(address);
      setIsRunning(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function stopServer() {
    try {
      await invoke("stop_screen_server");
      setIsRunning(false);
      setServerAddress("");
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="screen-mode">
      <button className="back-btn" onClick={() => setMode("home")}>
        ← Quay lại
      </button>
      <h1>📡 Chia sẻ màn hình (WebSocket)</h1>

      {!isRunning ? (
        <button onClick={startServer} className="btn-primary">
          Bắt đầu chia sẻ
        </button>
      ) : (
        <>
          <div className="server-info">
            <p>Đang chia sẻ tại:</p>
            <code>ws://{serverAddress}</code>
            <p className="hint">Các máy client kết nối đến địa chỉ này</p>
          </div>
          <button onClick={stopServer} className="btn-danger">
            Dừng chia sẻ
          </button>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}

function ClientScreen({ setMode }: { setMode: (m: Mode) => void }) {
  const [serverIp, setServerIp] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  function connect() {
    if (!serverIp) return;
    setError("");
    const ws = new WebSocket(`ws://${serverIp}`);

    ws.onopen = () => setConnected(true);
    ws.onmessage = (event) => {
      if (imgRef.current) {
        imgRef.current.src = `data:image/jpeg;base64,${event.data}`;
      }
    };
    ws.onerror = () => {
      setError("Không thể kết nối đến server");
      setConnected(false);
    };
    ws.onclose = () => setConnected(false);
    wsRef.current = ws;
  }

  function disconnect() {
    wsRef.current?.close();
    setConnected(false);
  }

  useEffect(() => () => { wsRef.current?.close(); }, []);

  return (
    <div className="screen-mode">
      <button className="back-btn" onClick={() => setMode("home")}>
        ← Quay lại
      </button>
      <h1>👁️ Xem màn hình (WebSocket)</h1>

      {!connected ? (
        <div className="connect-form">
          <input
            type="text"
            placeholder="IP:Port (vd: 192.168.1.5:9000)"
            value={serverIp}
            onChange={(e) => setServerIp(e.target.value)}
          />
          <button onClick={connect} className="btn-primary">
            Kết nối
          </button>
        </div>
      ) : (
        <>
          <div className="viewer">
            <img ref={imgRef} alt="Screen" />
          </div>
          <button onClick={disconnect} className="btn-danger">
            Ngắt kết nối
          </button>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}

function ScannerScreen({ setMode }: { setMode: (m: Mode) => void }) {
  const [localIp, setLocalIp] = useState<string>("");
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string>("");
  const [filter, setFilter] = useState<string>("all");

  async function scanNetwork() {
    setScanning(true);
    setError("");
    setHosts([]);
    try {
      const ip = await invoke<string>("get_local_ip");
      setLocalIp(ip);
      const result = await invoke<HostInfo[]>("scan_network");
      setHosts(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  const filteredHosts = hosts.filter((h) => {
    if (filter === "all") return true;
    if (filter === "named") return h.hostname;
    return h.source === filter;
  });

  const counts = {
    all: hosts.length,
    mDNS: hosts.filter((h) => h.source === "mDNS").length,
    ARP: hosts.filter((h) => h.source === "ARP").length,
    Ping: hosts.filter((h) => h.source === "Ping").length,
    TCP: hosts.filter((h) => h.source === "TCP").length,
    named: hosts.filter((h) => h.hostname).length,
  };

  return (
    <div className="screen-mode">
      <button className="back-btn" onClick={() => setMode("home")}>
        ← Quay lại
      </button>
      <h1>🔍 LAN Scanner</h1>

      {localIp && (
        <p className="local-ip">
          Your IP: <strong>{localIp}</strong>
        </p>
      )}

      <button onClick={scanNetwork} disabled={scanning} className="btn-primary">
        {scanning ? "Đang quét..." : "Quét mạng LAN"}
      </button>

      {error && <p className="error">{error}</p>}
      {scanning && <p className="scanning">Đang quét mDNS + ARP + TCP...</p>}

      {hosts.length > 0 && (
        <>
          <div className="filters">
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
              Tất cả ({counts.all})
            </button>
            <button className={filter === "mDNS" ? "active" : ""} onClick={() => setFilter("mDNS")}>
              mDNS ({counts.mDNS})
            </button>
            <button className={filter === "ARP" ? "active" : ""} onClick={() => setFilter("ARP")}>
              ARP ({counts.ARP})
            </button>
            {counts.Ping > 0 && (
              <button className={filter === "Ping" ? "active" : ""} onClick={() => setFilter("Ping")}>
                Ping ({counts.Ping})
              </button>
            )}
            {counts.TCP > 0 && (
              <button className={filter === "TCP" ? "active" : ""} onClick={() => setFilter("TCP")}>
                TCP ({counts.TCP})
              </button>
            )}
            <button className={filter === "named" ? "active" : ""} onClick={() => setFilter("named")}>
              Có tên ({counts.named})
            </button>
          </div>

          <div className="results">
            <h2>Hiển thị {filteredHosts.length} thiết bị</h2>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Địa chỉ IP</th>
                  <th>Hostname</th>
                  <th>Nguồn</th>
                </tr>
              </thead>
              <tbody>
                {filteredHosts.map((host, index) => (
                  <tr key={host.ip}>
                    <td>{index + 1}</td>
                    <td>{host.ip}</td>
                    <td>{host.hostname || "-"}</td>
                    <td className={host.source.toLowerCase()}>{host.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export default App;

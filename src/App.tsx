import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface HostInfo {
  ip: string;
  hostname: string | null;
  source: string;
}

type Mode = "home" | "server" | "client" | "scanner";

function App() {
  const [mode, setMode] = useState<Mode>("home");

  return (
    <main className="container">
      {mode === "home" && <HomeScreen setMode={setMode} />}
      {mode === "server" && <ServerScreen setMode={setMode} />}
      {mode === "client" && <ClientScreen setMode={setMode} />}
      {mode === "scanner" && <ScannerScreen setMode={setMode} />}
    </main>
  );
}

function HomeScreen({ setMode }: { setMode: (m: Mode) => void }) {
  return (
    <div className="home">
      <h1>🖥️ Screen Share</h1>
      <p className="subtitle">Chia sẻ màn hình qua mạng LAN</p>
      <div className="home-buttons">
        <button onClick={() => setMode("server")} className="btn-primary">
          📡 Chia sẻ màn hình
        </button>
        <button onClick={() => setMode("client")} className="btn-secondary">
          👁️ Xem màn hình
        </button>
        <button onClick={() => setMode("scanner")} className="btn-outline">
          🔍 Quét mạng LAN
        </button>
      </div>
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
      const address = await invoke<string>("start_screen_server", {
        port: 9000,
      });
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
      <h1>📡 Chia sẻ màn hình</h1>

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

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (event) => {
      if (imgRef.current) {
        imgRef.current.src = `data:image/jpeg;base64,${event.data}`;
      }
    };

    ws.onerror = () => {
      setError("Không thể kết nối đến server");
      setConnected(false);
    };

    ws.onclose = () => {
      setConnected(false);
    };

    wsRef.current = ws;
  }

  function disconnect() {
    wsRef.current?.close();
    setConnected(false);
  }

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  return (
    <div className="screen-mode">
      <button className="back-btn" onClick={() => setMode("home")}>
        ← Quay lại
      </button>
      <h1>👁️ Xem màn hình</h1>

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
            <button
              className={filter === "all" ? "active" : ""}
              onClick={() => setFilter("all")}
            >
              Tất cả ({counts.all})
            </button>
            <button
              className={filter === "mDNS" ? "active" : ""}
              onClick={() => setFilter("mDNS")}
            >
              mDNS ({counts.mDNS})
            </button>
            <button
              className={filter === "ARP" ? "active" : ""}
              onClick={() => setFilter("ARP")}
            >
              ARP ({counts.ARP})
            </button>
            {counts.Ping > 0 && (
              <button
                className={filter === "Ping" ? "active" : ""}
                onClick={() => setFilter("Ping")}
              >
                Ping ({counts.Ping})
              </button>
            )}
            {counts.TCP > 0 && (
              <button
                className={filter === "TCP" ? "active" : ""}
                onClick={() => setFilter("TCP")}
              >
                TCP ({counts.TCP})
              </button>
            )}
            <button
              className={filter === "named" ? "active" : ""}
              onClick={() => setFilter("named")}
            >
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

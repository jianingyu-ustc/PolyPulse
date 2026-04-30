export class ConsoleReporter {
  stage(event) {
    const artifact = event.artifact ?? "-";
    const status = event.status ?? "ok";
    const stage = event.stage ?? "unknown";
    console.error(`[stage] ${stage} | [status] ${status} | [artifact] ${artifact}`);
  }

  result(summary) {
    console.log(JSON.stringify(summary, null, 2));
  }

  alert(alert) {
    const artifact = alert.artifact ?? "-";
    const status = alert.status ?? "warn";
    const stage = alert.stage ?? "alert";
    console.error(`[stage] ${stage} | [status] ${status} | [artifact] ${artifact}`);
  }
}

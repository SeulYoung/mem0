/**
 * Desktop notification, dependency-free.
 *
 * The alert has to reach you somewhere other than the tool that just broke, so
 * this deliberately avoids anything that lives inside the IDE. On Windows that
 * means a toast through PowerShell's WinRT bindings, falling back to a message
 * box when the toast is refused — which happens on stripped-down systems and
 * when notifications are switched off entirely.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { log } from "./paths.mjs";

const run = promisify(execFile);

/** PowerShell needs its own quotes doubled; -EncodedCommand handles the rest. */
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

const powershell = () =>
  path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/**
 * A toast needs the AUMID of an installed application to be shown at all.
 * PowerShell's own is present on every Windows install, which buys us a working
 * notification without registering a shortcut of our own.
 */
const TOAST_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

function toastScript(title, body) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$text = $xml.GetElementsByTagName('text')",
    `$text.Item(0).AppendChild($xml.CreateTextNode(${quote(title)})) > $null`,
    `$text.Item(1).AppendChild($xml.CreateTextNode(${quote(body)})) > $null`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${quote(TOAST_APP_ID)}).Show($toast)`,
  ].join("\n");
}

function messageBoxScript(title, body) {
  return [
    "Add-Type -AssemblyName System.Windows.Forms > $null",
    `[System.Windows.Forms.MessageBox]::Show(${quote(body)}, ${quote(title)}, 'OK', 'Warning') > $null`,
  ].join("\n");
}

const encode = (script) => Buffer.from(script, "utf16le").toString("base64");

async function notifyWindows(title, body) {
  try {
    await run(powershell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encode(toastScript(title, body))], {
      timeout: 15000,
      windowsHide: true,
    });
    return { delivered: true, via: "toast" };
  } catch (error) {
    // A message box blocks until it is dismissed, so it must not be awaited:
    // the watchdog would sit there holding the alert open for hours.
    try {
      const child = spawn(
        powershell(),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encode(messageBoxScript(title, body))],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.unref();
      return { delivered: true, via: `message box (toast failed: ${error.message.split("\n")[0]})` };
    } catch (fallbackError) {
      return { delivered: false, via: `no channel worked: ${fallbackError.message}` };
    }
  }
}

async function notifyPosix(title, body) {
  const attempts =
    process.platform === "darwin"
      ? [["osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]]]
      : [["notify-send", ["--urgency=critical", title, body]]];

  for (const [command, args] of attempts) {
    try {
      await run(command, args, { timeout: 15000 });
      return { delivered: true, via: command };
    } catch {
      // try the next channel
    }
  }
  return { delivered: false, via: "no desktop notifier available" };
}

/**
 * Never throws: an alert that fails to display must still leave a trace in the
 * log rather than take down the watchdog that produced it.
 */
export async function notify({ title, body }) {
  try {
    const result = process.platform === "win32" ? await notifyWindows(title, body) : await notifyPosix(title, body);
    log("watchdog", `notification ${result.delivered ? "sent" : "failed"} via ${result.via}`);
    return result;
  } catch (error) {
    log("watchdog", `notification failed: ${error.message}`);
    return { delivered: false, via: error.message };
  }
}

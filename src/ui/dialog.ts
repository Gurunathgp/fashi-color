// Platform-aware dialogs.
//
// Why this exists: `react-native-web` ships an `Alert` whose `alert()` is an empty function. On the
// web export every dialog in this app therefore did nothing at all — the consent copy, the "this
// capture produced no usable measurement" warning, and worst of all the "Delete all my data"
// confirmation, which could never run because its buttons were never rendered. The user-visible
// symptom was a button that silently ignored taps. This module is the one place that knows the
// difference, so call sites never have to.

import { Alert, Platform } from "react-native";

export type ConfirmOptions = {
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
};

type WebDialogHost = {
  alert?: (message?: unknown) => void;
  confirm?: (message?: string) => boolean;
};

/** The browser globals, or null when this platform is not the web bundle. */
function webHost(): WebDialogHost | null {
  const g = globalThis as unknown as { window?: WebDialogHost };
  return g.window ?? (globalThis as unknown as WebDialogHost);
}

export function isWeb(): boolean {
  return Platform.OS === "web";
}

/** Fire-and-forget message. Never silently drops the text. */
export function notify(title: string, message: string): void {
  if (isWeb()) {
    const host = webHost();
    if (typeof host?.alert === "function") host.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}

/**
 * Yes/no confirmation. Resolves `false` on cancel, on dismissal, and on any platform that cannot
 * show the dialog at all — refusing is always the safe default for a destructive action.
 */
export function confirm(title: string, message: string, options: ConfirmOptions = {}): Promise<boolean> {
  const { confirmText = "OK", cancelText = "Cancel", destructive = false } = options;

  if (isWeb()) {
    const host = webHost();
    if (typeof host?.confirm !== "function") return Promise.resolve(false);
    return Promise.resolve(Boolean(host.confirm(`${title}\n\n${message}`)));
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    Alert.alert(
      title,
      message,
      [
        { text: cancelText, style: "cancel", onPress: () => settle(false) },
        {
          text: confirmText,
          style: destructive ? "destructive" : "default",
          onPress: () => settle(true),
        },
      ],
      { cancelable: true, onDismiss: () => settle(false) }
    );
  });
}

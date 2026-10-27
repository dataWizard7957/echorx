// Tiny typed client for the EchoRx API.
export type Lang = "en" | "bn" | "ar" | "es";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  status: () => req<any>("GET", "/api/status"),
  patients: () => req<any[]>("GET", "/api/patients"),
  createCase: (patientId: string, language: Lang) => req<any>("POST", "/api/cases", { patientId, language }),
  getCase: (id: string) => req<any>("GET", `/api/cases/${id}`),
  listCases: () => req<any[]>("GET", "/api/cases"),
  message: (id: string, text: string, text_en?: string) => req<any>("POST", `/api/cases/${id}/message`, { text, text_en }),
  photo: (id: string, body: { dataUrl?: string; sampleId?: string }) => req<any>("POST", `/api/cases/${id}/photo`, body),
  finish: (id: string) => req<any>("POST", `/api/cases/${id}/finish`),
  inbox: () => req<any>("GET", "/api/nurse/inbox"),
  decide: (id: string, escalationId: string, decision: string, saveAsRule: boolean) => req<any>("POST", `/api/nurse/${id}/decide`, { escalationId, decision, saveAsRule }),
  approve: (id: string) => req<any>("POST", `/api/nurse/${id}/approve`),
  ask: (id: string, question: string) => req<any>("POST", `/api/nurse/${id}/ask`, { question }),
  memoryWrong: (id: string, escalationId: string) => req<any>("POST", `/api/nurse/${id}/memory-wrong`, { escalationId }),
  memory: () => req<any[]>("GET", "/api/memory"),
  reset: (memory = true) => req<any>("POST", "/api/demo/reset", { memory }),
};

/** Load a sample bottle PNG as a data URL so live mode can send the real image to the vision lane. */
export async function sampleBottleDataUrl(id: string): Promise<string> {
  const blob = await (await fetch(`/samples/${id}.png`)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

export function fileToDataUrl(file: File, maxSide = 1280): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

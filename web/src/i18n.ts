import type { Lang } from "./api";

export const LANG_LABEL: Record<Lang, string> = { en: "English", bn: "বাংলা", ar: "العربية", es: "Español" };
export const dir = (l: Lang) => (l === "ar" ? "rtl" : "ltr");

const T = {
  chooseLang: { en: "Choose your language", bn: "আপনার ভাষা বেছে নিন", ar: "اختر لغتك", es: "Elija su idioma" },
  consentTitle: { en: "Before we start", bn: "শুরু করার আগে", ar: "قبل أن نبدأ", es: "Antes de empezar" },
  consent: {
    en: "EchoRx asks a few questions and shares your answers with your van nurse, doctor and pharmacist, so you only tell your story once. It does not give medical advice. In an emergency, call 911.",
    bn: "EchoRx কয়েকটি প্রশ্ন করবে এবং আপনার উত্তর ভ্যানের নার্স, ডাক্তার ও ফার্মাসিস্টকে জানাবে, যাতে আপনাকে একবারই সব বলতে হয়। এটি চিকিৎসা পরামর্শ দেয় না। জরুরি অবস্থায় ৯১১-এ কল করুন।",
    ar: "يطرح EchoRx بعض الأسئلة ويشارك إجاباتك مع ممرضة العيادة المتنقلة والطبيب والصيدلي، حتى تروي قصتك مرة واحدة فقط. لا يقدم نصائح طبية. في حالة الطوارئ اتصل بـ 911.",
    es: "EchoRx le hace unas preguntas y comparte sus respuestas con la enfermera, el médico y el farmacéutico de la camioneta, para que cuente su historia una sola vez. No da consejos médicos. En una emergencia, llame al 911.",
  },
  agree: { en: "I agree, start", bn: "আমি রাজি, শুরু করুন", ar: "أوافق، ابدأ", es: "Acepto, empezar" },
  type: { en: "Type your answer…", bn: "আপনার উত্তর লিখুন…", ar: "اكتب إجابتك…", es: "Escriba su respuesta…" },
  send: { en: "Send", bn: "পাঠান", ar: "إرسال", es: "Enviar" },
  photo: { en: "Photo of a pill bottle", bn: "ওষুধের বোতলের ছবি", ar: "صورة علبة الدواء", es: "Foto del frasco" },
  sampleBottles: { en: "Sample bottles", bn: "নমুনা বোতল", ar: "علب تجريبية", es: "Frascos de ejemplo" },
  upload: { en: "Take or upload a photo", bn: "ছবি তুলুন বা আপলোড করুন", ar: "التقط أو حمّل صورة", es: "Tomar o subir foto" },
  finish: { en: "Send to my care team", bn: "কেয়ার টিমকে পাঠান", ar: "أرسل إلى فريق الرعاية", es: "Enviar a mi equipo" },
  working: { en: "Your care team's agents are checking…", bn: "আপনার কেয়ার টিমের এজেন্টরা যাচাই করছে…", ar: "وكلاء فريق الرعاية يتحققون…", es: "Los agentes de su equipo están revisando…" },
  call: { en: "Call 911", bn: "৯১১-এ কল করুন", ar: "اتصل بـ 911", es: "Llamar al 911" },
  booked: { en: "Your van visit", bn: "আপনার ভ্যান ভিজিট", ar: "موعد العيادة المتنقلة", es: "Su visita" },
  whoAreYou: { en: "Demo patient", bn: "ডেমো রোগী", ar: "مريض تجريبي", es: "Paciente de demostración" },
} satisfies Record<string, Record<Lang, string>>;

export const t = (k: keyof typeof T, l: Lang) => T[k][l];

"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Language = "ko" | "vi";

type LanguageContextType = {
  lang: Language;
  setLang: (lang: Language) => void;
  toggleLang: () => void;
};

const LanguageContext = createContext<LanguageContextType | null>(null);

export function LanguageProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [lang, setLangState] = useState<Language>("ko");

  useEffect(() => {
    const savedUser = localStorage.getItem("baba_user");

    if (!savedUser) return;

    const parsedUser = JSON.parse(savedUser);
    const savedLang = parsedUser?.language;

    if (savedLang === "vi" || savedLang === "ko") {
      setLangState(savedLang);
    }
  }, []);

  const setLang = (newLang: Language) => {
    setLangState(newLang);

    const savedUser = localStorage.getItem("baba_user");
    if (!savedUser) return;

    const parsedUser = JSON.parse(savedUser);
    parsedUser.language = newLang;
    localStorage.setItem("baba_user", JSON.stringify(parsedUser));
  };

  const toggleLang = () => {
    setLang(lang === "ko" ? "vi" : "ko");
  };

  return (
    <LanguageContext.Provider value={{ lang, setLang, toggleLang }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);

  if (!context) {
    throw new Error("useLanguage must be used inside LanguageProvider");
  }

  return context;
}
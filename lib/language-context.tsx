"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Language = "ko" | "vi";

type LanguageContextType = {
  lang: Language;
  setLang: (lang: Language) => void;
  toggleLang: () => void;
};

const LanguageContext = createContext<LanguageContextType | null>(null);

function getDefaultLangFromUser(user: any): Language {
  if (user?.language === "vi" || user?.language === "ko") {
    return user.language;
  }

  if (user?.role === "staff") {
    return "vi";
  }

  return "ko";
}

export function LanguageProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [lang, setLangState] = useState<Language>("ko");

  useEffect(() => {
    const savedUser = localStorage.getItem("baba_user");
    if (!savedUser) return;

    try {
      const parsedUser = JSON.parse(savedUser);
      const defaultLang = getDefaultLangFromUser(parsedUser);

      setLangState(defaultLang);

      if (parsedUser.language !== defaultLang) {
        parsedUser.language = defaultLang;
        localStorage.setItem("baba_user", JSON.stringify(parsedUser));
      }
    } catch (error) {
      console.error("Failed to parse baba_user from localStorage", error);
    }
  }, []);

  const setLang = (newLang: Language) => {
    setLangState(newLang);

    const savedUser = localStorage.getItem("baba_user");
    if (!savedUser) return;

    try {
      const parsedUser = JSON.parse(savedUser);
      parsedUser.language = newLang;
      localStorage.setItem("baba_user", JSON.stringify(parsedUser));
    } catch (error) {
      console.error("Failed to update language in baba_user", error);
    }
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
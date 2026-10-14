/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#84006A",
        secondary: "#FFFFFF",
        accent: "#000000",
        backgroundLight: "#FAFAFA",
        backgroundDark: "#F5F5F5",
        darkBackground: "#1A1A1A",
        darkBackgroundVery: "#0F0F0F",
        textLight: "#333333",
        workflow: {
          pending: "#F5A700",
          running: "#2563EB",
          done: "#16A34A",
          failed: "#DC2626",
          healing: "#A855F7",
        },
        dark: {
          primary: "#84006A",
          secondary: "#1F2937",
          background: "#111827",
          surface: "#1F2937",
          text: "#F9FAFB",
          darkBackground: "#1A1A1A",
          darkBackgroundVery: "#0F0F0F",
        },
      },
      boxShadow: {
        soft: "0 18px 45px rgba(15, 15, 15, 0.08)",
        panel: "0 14px 30px rgba(0, 0, 0, 0.16)",
      },
      fontFamily: {
        sans: ["Open Sans", "sans-serif"],
      },
    },
  },
  plugins: [
    function ({ addUtilities }) {
      addUtilities({
        ".scrollbar-hide": {
          "-webkit-overflow-scrolling": "touch",
          "scrollbar-width": "none",
          "-ms-overflow-style": "none",
        },
        ".scrollbar-hide::-webkit-scrollbar": {
          display: "none",
        },
      });
    },
  ],
};

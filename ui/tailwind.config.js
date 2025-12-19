/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: "#0a0a0a",
          surface: "#111111",
          border: "#1a1a1a",
          green: "#00ff88",
          cyan: "#00d4ff",
          amber: "#ffaa00",
          red: "#ff4444",
          dimmed: "#666666",
        },
      },
      fontFamily: {
        mono: ["Space Mono", "monospace"],
        sans: ["Space Grotesk", "sans-serif"],
      },
      animation: {
        pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        glow: "glow 2s ease-in-out infinite alternate",
      },
      keyframes: {
        glow: {
          "0%": { boxShadow: "0 0 5px currentColor, 0 0 10px currentColor" },
          "100%": { boxShadow: "0 0 10px currentColor, 0 0 20px currentColor, 0 0 30px currentColor" },
        },
      },
    },
  },
  plugins: [],
};

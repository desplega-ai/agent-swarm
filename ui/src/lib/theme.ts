import { extendTheme } from "@mui/joy/styles";

export const theme = extendTheme({
  colorSchemes: {
    dark: {
      palette: {
        background: {
          body: "#0D0906",      // deep hive interior
          surface: "#1A130E",   // warm dark brown
          level1: "#251C15",    // rich earth
          level2: "#2F2419",    // honeycomb shadow
          level3: "#3A2D1F",    // lighter earth
        },
        text: {
          primary: "#FFF8E7",   // cream white
          secondary: "#C9B896", // warm gray
          tertiary: "#8B7355",  // muted brown
        },
        primary: {
          50: "#FFF5E0",
          100: "#FFE8B8",
          200: "#FFD98A",
          300: "#FFC95C",
          400: "#FFB84D",       // bright honey
          500: "#F5A623",       // primary amber
          600: "#C67C00",       // deep amber
          700: "#9A5F00",
          800: "#6E4400",
          900: "#422800",
          solidBg: "#F5A623",
          solidHoverBg: "#FFB84D",
          solidActiveBg: "#C67C00",
          softBg: "rgba(245, 166, 35, 0.15)",
          softHoverBg: "rgba(245, 166, 35, 0.25)",
          softColor: "#F5A623",
        },
        success: {
          500: "#D4A574",       // warm gold
          softBg: "rgba(212, 165, 116, 0.15)",
          softColor: "#D4A574",
        },
        warning: {
          500: "#F5A623",       // pulsing amber
          softBg: "rgba(245, 166, 35, 0.15)",
          softColor: "#F5A623",
        },
        danger: {
          500: "#A85454",       // rust red
          softBg: "rgba(168, 84, 84, 0.15)",
          softColor: "#A85454",
        },
        neutral: {
          50: "#FFF8E7",
          100: "#E8DCC8",
          200: "#C9B896",
          300: "#A89A7C",
          400: "#8B7355",
          500: "#6B5344",       // dormant brown
          600: "#4A3A2F",
          700: "#3A2D1F",
          800: "#251C15",
          900: "#1A130E",
          outlinedBorder: "#3A2D1F",
        },
      },
    },
    light: {
      palette: {
        background: {
          body: "#FDF8F3",      // warm cream
          surface: "#FFFFFF",   // white
          level1: "#F5EDE4",    // light warm
          level2: "#EDE3D7",    // slightly darker
          level3: "#E5D9CA",    // warm gray
        },
        text: {
          primary: "#1A130E",   // dark brown
          secondary: "#5C4A3D", // medium brown
          tertiary: "#8B7355",  // muted brown
        },
        primary: {
          50: "#FFF5E0",
          100: "#FFE8B8",
          200: "#FFD98A",
          300: "#FFC95C",
          400: "#FFB84D",
          500: "#D48806",       // slightly darker amber for light mode
          600: "#B87300",
          700: "#9A5F00",
          800: "#6E4400",
          900: "#422800",
          solidBg: "#D48806",
          solidHoverBg: "#B87300",
          solidActiveBg: "#9A5F00",
          softBg: "rgba(212, 136, 6, 0.12)",
          softHoverBg: "rgba(212, 136, 6, 0.20)",
          softColor: "#B87300",
        },
        success: {
          500: "#8B6914",       // darker gold for light mode
          softBg: "rgba(139, 105, 20, 0.12)",
          softColor: "#8B6914",
        },
        warning: {
          500: "#D48806",
          softBg: "rgba(212, 136, 6, 0.12)",
          softColor: "#D48806",
        },
        danger: {
          500: "#B54242",       // darker red for light mode
          softBg: "rgba(181, 66, 66, 0.12)",
          softColor: "#B54242",
        },
        neutral: {
          50: "#1A130E",
          100: "#2F2419",
          200: "#4A3A2F",
          300: "#6B5344",
          400: "#8B7355",
          500: "#A89A7C",
          600: "#C9B896",
          700: "#E5D9CA",
          800: "#F5EDE4",
          900: "#FDF8F3",
          outlinedBorder: "#E5D9CA",
        },
      },
    },
  },
  fontFamily: {
    // body: "'Graduate', sans-serif",
    // display: "'Graduate', sans-serif",
    // code: "'Space Mono', monospace",
    body: "'Courier', sans-serif",
    display: "'Courier', sans-serif",
    code: "'Courier', sans-serif",
  },
  components: {
    JoyCard: {
      styleOverrides: {
        root: ({ theme }) => ({
          backgroundColor: theme.vars.palette.background.surface,
          borderColor: theme.vars.palette.neutral.outlinedBorder,
          borderWidth: "1px",
          borderStyle: "solid",
        }),
      },
    },
    JoyInput: {
      styleOverrides: {
        root: ({ theme }) => ({
          fontFamily: "'Space Mono', monospace",
          backgroundColor: theme.vars.palette.background.surface,
          borderColor: theme.vars.palette.neutral.outlinedBorder,
        }),
      },
    },
    JoySelect: {
      styleOverrides: {
        root: ({ theme }) => ({
          fontFamily: "'Space Mono', monospace",
          backgroundColor: theme.vars.palette.background.surface,
          borderColor: theme.vars.palette.neutral.outlinedBorder,
          "&:hover": {
            backgroundColor: theme.vars.palette.background.level1,
          },
        }),
        listbox: ({ theme }) => ({
          backgroundColor: theme.vars.palette.background.surface,
          borderColor: theme.vars.palette.neutral.outlinedBorder,
          fontFamily: "'Space Mono', monospace",
          padding: "4px",
        }),
      },
    },
    JoyOption: {
      styleOverrides: {
        root: ({ theme }) => ({
          fontFamily: "'Space Mono', monospace",
          backgroundColor: "transparent",
          color: theme.vars.palette.text.primary,
          "&:hover": {
            backgroundColor: theme.vars.palette.background.level1,
          },
          "&[aria-selected='true']": {
            backgroundColor: theme.vars.palette.background.level2,
            color: theme.vars.palette.text.primary,
          },
        }),
      },
    },
    JoyButton: {
      styleOverrides: {
        root: {
          fontWeight: 600,
        },
      },
    },
    JoyChip: {
      styleOverrides: {
        root: {
          fontFamily: "'Space Mono', monospace",
        },
      },
    },
    JoyTable: {
      styleOverrides: {
        root: ({ theme }) => ({
          "--TableCell-borderColor": theme.vars.palette.neutral.outlinedBorder,
        }),
      },
    },
  },
});

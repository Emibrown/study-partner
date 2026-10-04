import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["hemikaryotic-waifishly-garland.ngrok-free.dev"],
  devIndicators: false,
  logging: { incomingRequests: false },
  distDir: process.env.NEXT_BUILD_DIR || ".next",
  // Test transport is impossible to select for production builds or real agents.
  ...(process.env.NODE_ENV === "development" &&
  process.env.VOICE_TEST_SDK === "isolated" &&
  process.env.BETTER_AUTH_URL === "http://localhost:3100" &&
  process.env.ELEVENLABS_API_KEY === "fictional-eleven-key"
    ? {
        turbopack: {
          resolveAlias: { "@elevenlabs/react": "./tests/mock-voice-sdk.tsx" },
        },
      }
    : {}),
};
export default nextConfig;

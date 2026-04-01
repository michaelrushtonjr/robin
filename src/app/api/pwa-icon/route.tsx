import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const size = parseInt(request.nextUrl.searchParams.get("size") || "192");

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #1e40af 0%, #1d4ed8 100%)",
          borderRadius: "22%",
        }}
      >
        <span
          style={{
            fontSize: Math.round(size * 0.52),
            fontWeight: 800,
            color: "white",
            fontFamily: "serif",
            letterSpacing: "-0.02em",
          }}
        >
          R
        </span>
      </div>
    ),
    { width: size, height: size }
  );
}

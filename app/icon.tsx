import { ImageResponse } from 'next/og';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '4px solid #f2e9dd',
        borderRadius: 16,
        color: '#fffaf2',
        background: '#632f3b',
        fontFamily: 'serif',
        fontSize: 43,
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      L
    </div>,
    size,
  );
}

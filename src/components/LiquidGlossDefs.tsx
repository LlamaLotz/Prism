import React from 'react';

/**
 * Defines the SVG filter resources used by Liquid Gloss. The filters remain
 * dormant outside .theme-gloss and are mounted once so every panel can reuse
 * the same GPU/browser filter resources.
 */
export const LiquidGlossDefs: React.FC = () => (
  <>
    <svg
      className="liquid-gloss-defs"
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
      viewBox="0 0 1 1"
    >
      <defs>
        <filter
          id="liquid-gloss-refraction"
          x="-12%"
          y="-12%"
          width="124%"
          height="124%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.018 0.032"
            numOctaves="2"
            seed="17"
            result="liquidNoise"
          >
            <animate
              attributeName="baseFrequency"
              dur="16s"
              values="0.018 0.032;0.024 0.038;0.018 0.032"
              repeatCount="indefinite"
            />
          </feTurbulence>
          <feDisplacementMap
            in="SourceGraphic"
            in2="liquidNoise"
            scale="7"
            xChannelSelector="R"
            yChannelSelector="G"
            result="displacedSurface"
          />
          <feSpecularLighting
            in="liquidNoise"
            surfaceScale="3"
            specularConstant="0.7"
            specularExponent="28"
            lightingColor="#ffffff"
            result="specularSurface"
          >
            <feDistantLight azimuth="225" elevation="58" />
          </feSpecularLighting>
          <feComposite
            in="specularSurface"
            in2="SourceAlpha"
            operator="in"
            result="boundedSpecular"
          />
          <feComposite
            in="displacedSurface"
            in2="boundedSpecular"
            operator="arithmetic"
            k1="0"
            k2="1"
            k3="0.22"
            k4="0"
            result="glossSurface"
          />
          <feBlend in="glossSurface" in2="SourceGraphic" mode="screen" />
        </filter>

        <filter
          id="liquid-gloss-specular"
          x="-8%"
          y="-8%"
          width="116%"
          height="116%"
          colorInterpolationFilters="sRGB"
        >
          <feSpecularLighting
            in="SourceAlpha"
            surfaceScale="2"
            specularConstant="0.55"
            specularExponent="34"
            lightingColor="#ffffff"
            result="edgeLight"
          >
            <feDistantLight azimuth="225" elevation="62" />
          </feSpecularLighting>
          <feComposite in="edgeLight" in2="SourceAlpha" operator="in" />
        </filter>
      </defs>
    </svg>
    <div className="liquid-gloss-ambient" aria-hidden="true" />
  </>
);

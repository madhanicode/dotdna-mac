import { useEffect, useRef } from "react";
import "pixi.js/unsafe-eval";
import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import type { RestrictionSite } from "./restriction-sites";
import type { Feature, Topology } from "./types";

type Props = {
  name: string;
  topology: Topology;
  sequenceLength: number;
  features: Feature[];
  restrictionSites: RestrictionSite[];
  selectedFeature: number | null;
  onSelectFeature: (index: number) => void;
  zoom: number;
  showEnzymes: boolean;
};

const muted = 0x747982;
const foreground = 0xd9dce1;

function numericColor(value: string | null, fallback = 0x5cc8d7) {
  if (!value?.startsWith("#")) return fallback;
  return Number.parseInt(value.slice(1), 16);
}

function angleFor(position: number, length: number) {
  return -Math.PI / 2 + (position / Math.max(length, 1)) * Math.PI * 2;
}

function addTitle(scene: Container, name: string, subtitleText: string, x: number, y: number) {
  const title = new Text({
    text: name.replace(/\.[^.]+$/, ""),
    style: new TextStyle({ fill: foreground, fontFamily: "-apple-system, sans-serif", fontSize: 18, fontWeight: "600" }),
  });
  title.anchor.set(0.5, 0.5);
  title.position.set(x, y - 12);
  scene.addChild(title);

  const subtitle = new Text({
    text: subtitleText,
    style: new TextStyle({ fill: muted, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11 }),
  });
  subtitle.anchor.set(0.5, 0.5);
  subtitle.position.set(x, y + 14);
  scene.addChild(subtitle);
}

function drawCircular(scene: Container, props: Props, width: number, height: number) {
  const cx = width / 2;
  const cy = height / 2 - 4;
  const radius = Math.min(width, height) * 0.255 * props.zoom;
  const grid = new Graphics();
  for (let ring = 1; ring <= 3; ring += 1) {
    grid.circle(cx, cy, radius + ring * 28).stroke({ width: 1, color: 0x30343a, alpha: 0.34 });
  }
  scene.addChild(grid);
  scene.addChild(new Graphics().circle(cx, cy, radius).stroke({ width: 10, color: 0x2e3237 }));

  for (let tick = 0; tick < 12; tick += 1) {
    const angle = -Math.PI / 2 + tick / 12 * Math.PI * 2;
    const major = tick % 3 === 0;
    const inner = radius - (major ? 11 : 7);
    const outer = radius + (major ? 11 : 7);
    scene.addChild(new Graphics()
      .moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
      .lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
      .stroke({ width: major ? 1.5 : 1, color: major ? 0x81868f : 0x555a62, alpha: 0.9 }));
  }

  props.features.forEach((feature, featureIndex) => {
    const selected = props.selectedFeature === featureIndex;
    const featureRadius = radius + 1 + (featureIndex % 3) * 12;
    const graphic = new Graphics();
    for (const segment of feature.segments) {
      graphic.arc(cx, cy, featureRadius, angleFor(segment.span.start, props.sequenceLength), angleFor(segment.span.end, props.sequenceLength))
        .stroke({ width: selected ? 13 : 9, color: numericColor(segment.color ?? feature.color), alpha: selected ? 1 : 0.9 });
      if (feature.strand === "forward" || feature.strand === "reverse") {
        const position = feature.strand === "forward" ? segment.span.end : segment.span.start;
        const angle = angleFor(position, props.sequenceLength);
        const tangent = angle + (feature.strand === "forward" ? Math.PI / 2 : -Math.PI / 2);
        const markerX = cx + Math.cos(angle) * featureRadius;
        const markerY = cy + Math.sin(angle) * featureRadius;
        const normal = tangent + Math.PI / 2;
        graphic.poly([
          markerX + Math.cos(tangent) * 8, markerY + Math.sin(tangent) * 8,
          markerX + Math.cos(normal) * 5, markerY + Math.sin(normal) * 5,
          markerX - Math.cos(normal) * 5, markerY - Math.sin(normal) * 5,
        ]).fill({ color: numericColor(segment.color ?? feature.color), alpha: 1 });
      }
    }
    graphic.eventMode = "static";
    graphic.cursor = "pointer";
    graphic.on("pointertap", () => props.onSelectFeature(featureIndex));
    scene.addChild(graphic);

    const segment = feature.segments[0];
    if (!segment) return;
    const labelAngle = angleFor((segment.span.start + segment.span.end) / 2, props.sequenceLength);
    const leaderStart = featureRadius + 10;
    const leaderEnd = radius + 73 + (featureIndex % 2) * 18;
    const x1 = cx + Math.cos(labelAngle) * leaderStart;
    const y1 = cy + Math.sin(labelAngle) * leaderStart;
    const x2 = cx + Math.cos(labelAngle) * leaderEnd;
    const y2 = cy + Math.sin(labelAngle) * leaderEnd;
    scene.addChild(new Graphics().moveTo(x1, y1).lineTo(x2, y2)
      .stroke({ width: selected ? 1.5 : 1, color: selected ? 0xaeb4bd : 0x666b73, alpha: selected ? 1 : 0.75 }));
    const label = new Text({
      text: feature.name.length > 22 ? `${feature.name.slice(0, 20)}…` : feature.name,
      style: new TextStyle({
        fill: selected ? foreground : 0xa6aab1,
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        fontSize: selected ? 12 : 11,
        fontWeight: selected ? "600" : "400",
      }),
    });
    label.anchor.set(Math.cos(labelAngle) >= 0 ? 0 : 1, 0.5);
    label.position.set(x2 + (Math.cos(labelAngle) >= 0 ? 6 : -6), y2);
    label.eventMode = "static";
    label.cursor = "pointer";
    label.on("pointertap", () => props.onSelectFeature(featureIndex));
    scene.addChild(label);
  });

  if (props.showEnzymes) {
    props.restrictionSites.slice(0, 24).forEach((site, index) => {
      const angle = angleFor(site.position, props.sequenceLength);
      const inner = radius - 17;
      const outer = radius - 33 - (index % 2) * 10;
      scene.addChild(new Graphics()
        .moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
        .lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
        .stroke({ width: 1.25, color: 0x7e858e, alpha: 0.9 }));
      if (props.restrictionSites.length <= 8) {
        const enzymeLabel = new Text({
          text: `${site.enzyme} ${(site.position + 1).toLocaleString()}`,
          style: new TextStyle({ fill: 0x858b93, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 8 }),
        });
        enzymeLabel.anchor.set(Math.cos(angle) >= 0 ? 0 : 1, 0.5);
        enzymeLabel.position.set(cx + Math.cos(angle) * (outer - 4), cy + Math.sin(angle) * (outer - 4));
        scene.addChild(enzymeLabel);
      }
    });
  }
  addTitle(scene, props.name, `${props.sequenceLength.toLocaleString()} bp · circular`, cx, cy);
}

function drawLinear(scene: Container, props: Props, width: number, height: number) {
  const centerY = height / 2;
  const availableWidth = Math.min(width - 120, 920) * props.zoom;
  const startX = (width - availableWidth) / 2;
  const endX = startX + availableWidth;
  scene.addChild(new Graphics().moveTo(startX, centerY).lineTo(endX, centerY).stroke({ width: 8, color: 0x2e3237 }));

  for (let tick = 0; tick <= 10; tick += 1) {
    const x = startX + availableWidth * tick / 10;
    scene.addChild(new Graphics().moveTo(x, centerY - 8).lineTo(x, centerY + 8).stroke({ width: 1, color: 0x646a72 }));
  }

  props.features.forEach((feature, featureIndex) => {
    const selected = props.selectedFeature === featureIndex;
    feature.segments.forEach((segment) => {
      const x = startX + segment.span.start / Math.max(props.sequenceLength, 1) * availableWidth;
      const segmentWidth = Math.max(3, (segment.span.end - segment.span.start) / Math.max(props.sequenceLength, 1) * availableWidth);
      const y = centerY - 18 - (featureIndex % 4) * 14;
      const graphic = new Graphics().roundRect(x, y, segmentWidth, selected ? 12 : 9, 2)
        .fill({ color: numericColor(segment.color ?? feature.color), alpha: selected ? 1 : 0.88 });
      if ((feature.strand === "forward" || feature.strand === "reverse") && segmentWidth > 8) {
        const arrowX = feature.strand === "forward" ? x + segmentWidth : x;
        const direction = feature.strand === "forward" ? 1 : -1;
        graphic.poly([arrowX + direction * 6, y + 5, arrowX - direction * 2, y, arrowX - direction * 2, y + 10])
          .fill({ color: numericColor(segment.color ?? feature.color), alpha: 1 });
      }
      graphic.eventMode = "static";
      graphic.cursor = "pointer";
      graphic.on("pointertap", () => props.onSelectFeature(featureIndex));
      scene.addChild(graphic);
    });
    const segment = feature.segments[0];
    if (!segment) return;
    const label = new Text({
      text: feature.name,
      style: new TextStyle({ fill: selected ? foreground : 0x9ba0a8, fontFamily: "-apple-system, sans-serif", fontSize: 10 }),
    });
    label.anchor.set(0.5, 1);
    label.position.set(startX + (segment.span.start + segment.span.end) / 2 / Math.max(props.sequenceLength, 1) * availableWidth, centerY - 26 - (featureIndex % 4) * 14);
    scene.addChild(label);
  });

  if (props.showEnzymes) {
    props.restrictionSites.slice(0, 24).forEach((site, index) => {
      const x = startX + site.position / Math.max(props.sequenceLength, 1) * availableWidth;
      scene.addChild(new Graphics().moveTo(x, centerY + 8).lineTo(x, centerY + 23).stroke({ width: 1, color: 0x7e858e }));
      if (props.restrictionSites.length <= 8) {
        const label = new Text({ text: site.enzyme, style: new TextStyle({ fill: 0x858b93, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 8 }) });
        label.anchor.set(0.5, 0);
        label.position.set(x, centerY + 25 + (index % 2) * 10);
        scene.addChild(label);
      }
    });
  }
  addTitle(scene, props.name, `${props.sequenceLength.toLocaleString()} bp · linear`, width / 2, centerY + 86);
}

function redraw(application: Application, scene: Container, props: Props, host: HTMLDivElement) {
  const width = Math.max(host.clientWidth, 320);
  const height = Math.max(host.clientHeight, 240);
  application.renderer.resize(width, height);
  for (const child of scene.removeChildren()) child.destroy({ children: true });
  if (props.topology === "circular") drawCircular(scene, props, width, height);
  else drawLinear(scene, props, width, height);
  application.render();
}

export function PlasmidMap(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const applicationRef = useRef<Application | null>(null);
  const sceneRef = useRef<Container | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let observer: ResizeObserver | null = null;
    const application = new Application();

    void application.init({
      width: Math.max(host.clientWidth, 320),
      height: Math.max(host.clientHeight, 240),
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      backgroundAlpha: 0,
      preference: "webgl",
    }).then(() => {
      if (disposed) {
        application.destroy(true);
        return;
      }
      application.ticker.stop();
      applicationRef.current = application;
      const scene = new Container();
      sceneRef.current = scene;
      application.stage.addChild(scene);
      host.replaceChildren(application.canvas);
      application.canvas.setAttribute("role", "img");
      application.canvas.setAttribute("aria-label", `${propsRef.current.topology === "circular" ? "Circular" : "Linear"} DNA map for ${propsRef.current.name}`);
      redraw(application, scene, propsRef.current, host);
      observer = new ResizeObserver(() => redraw(application, scene, propsRef.current, host));
      observer.observe(host);
    }).catch((error: unknown) => {
      if (!disposed) host.replaceChildren(Object.assign(document.createElement("div"), { className: "map-render-error", textContent: `The DNA map could not start: ${String(error)}` }));
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      applicationRef.current = null;
      sceneRef.current = null;
      if (application.renderer) application.destroy(true);
    };
  }, []);

  useEffect(() => {
    const application = applicationRef.current;
    const scene = sceneRef.current;
    const host = hostRef.current;
    if (!application || !scene || !host) return;
    application.canvas.setAttribute("aria-label", `${props.topology === "circular" ? "Circular" : "Linear"} DNA map for ${props.name}`);
    redraw(application, scene, props, host);
  }, [props]);

  return (
    <div className="pixi-map" ref={hostRef}>
      <div className="sr-only" aria-label="Map features">
        {props.features.map((feature, index) => {
          const ranges = feature.segments.map((segment) => `${segment.span.start + 1} to ${segment.span.end}`).join(", ");
          return <button aria-pressed={props.selectedFeature === index} key={`${feature.name}-${index}`} onClick={() => props.onSelectFeature(index)}>{feature.name}, {feature.kind}, {feature.strand} strand, bases {ranges}</button>;
        })}
      </div>
    </div>
  );
}

import React, { useState, useRef, useCallback, useEffect } from "react";
import CodeEditor, { CodeEditorHandle } from "./components/CodeEditor";
import ThreeCanvas from './components/ThreeCanvas';
import { executePythonCode } from "./utils/pyodideRunner";
import { generateMeshFromScalarField } from "./utils/MarchingCubes";
import { splitBufferGeometry } from "./utils/splitBufferGeometry";
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import * as THREE from "three";
import { BounceLoader } from "react-spinners";
import Split from 'react-split';

import './App.css';

const DEFAULT_PYTHON_CODE = `# Define your scalar_field function below!
import numpy as np

def smoothstep(edge0, edge1, x):
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3 - 2 * t)

# Signed distance to box shell
def box_shell(x, y, z, center=(0.5, 0.5, 0.5), inner=0.3, outer=0.4):
    dx = np.abs(x - center[0])
    dy = np.abs(y - center[1])
    dz = np.abs(z - center[2])
    r = np.maximum.reduce([dx, dy, dz])
    return np.maximum(r - outer, inner - r)

# Gyroid TPMS function
def gyroid(x, y, z, freq=6.0):
    f = freq * np.pi
    val = (
        np.sin(f * x) * np.cos(f * y) +
        np.sin(f * y) * np.cos(f * z) +
        np.sin(f * z) * np.cos(f * x)
    )
    return val / 3.0  # Normalize to roughly [-1, 1]

def scalar_field(x, y, z):
    shell = box_shell(x, y, z)

    # Gyroid inside the box
    gyroid_val = gyroid(x, y, z)

    # Smooth blend from gyroid (inside) to shell (outside)
    dx = np.abs(x - 0.5)
    dy = np.abs(y - 0.5)
    dz = np.abs(z - 0.5)
    r = np.maximum.reduce([dx, dy, dz])
    blend = smoothstep(0.295, 0.305, r)
    
    sdf = (1 - blend) * gyroid_val + blend * shell

    # Clamp to SDF range [-1, 1] and normalize to uint8
    sdf = np.clip(sdf, -1.0, 1.0)
    sdf = (sdf + 1.0) / 2.0  # Now: -1 → 0, 0 → 0.5, +1 → 1.0
    sdf *= 255
    return sdf.astype(np.uint8)`;

const App = () => {
  const [pythonCode, setPythonCode] = useState(DEFAULT_PYTHON_CODE);
  const [rawData, setRawData] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renderMode, setRenderMode] = useState<"surface" | "volume">("volume");


  // Create a ref for the CodeEditor
  const editorRef = useRef<CodeEditorHandle>(null);
  const canvasRef = useRef<{ resize: () => void } | null>(null);


  // Slider controls state
  const [u_dt, setUDt] = useState(0.01);
  const [u_color, setUColor] = useState(1.0);
  const [u_alphaVal, setUAlphaVal] = useState(1.0);
  const [u_isoValue, setUIsoValue] = useState(0);
  const [u_crossSectionSize, setUCrossSectionSize] = useState({ x: 0.5, y: 0.5, z: 0.5 });
  const [showControls, setShowControls] = useState(true);


   // Run the default code once on mount
   useEffect(() => {
    async function runDefault() {
      if (editorRef.current) {
        const code = editorRef.current.getCode();
        try {
          const result = await executePythonCode(code);
          setRawData(result);
        } catch (error) {
          console.error("Error executing default Python code:", error);
        }
      }
      setLoading(false);
    }
    runDefault();
  }, []);

  useEffect(() => {
    console.log("Render mode changed:", renderMode);
  }, [renderMode]);

  useEffect(() => {
    const onWindowResize = () => canvasRef.current?.resize();
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  // When "Run Code" is pressed, get the current code from the editor and evaluate it
  const handleRunCode = useCallback(async () => {
    if (editorRef.current) {
      const code = editorRef.current.getCode();
      console.log("Evaluating code...");
      setLoading(true); // ✅ Start loading
  
      try {
        const result = await executePythonCode(code);
        setRawData(result);
      } catch (error) {
        console.error("Error executing Python code:", error);
        setError("There was an error running your Python code.");
      } finally {
        setLoading(false); // ✅ Stop loading no matter what
      }
    }
  }, []);

  const dim = 256; // Resolution

  const handleSaveMesh = useCallback(() => {
    if (!rawData) {
      console.error("No volume data available to generate mesh.");
      return;
    }
  
    const fullGeometry: THREE.BufferGeometry = generateMeshFromScalarField(rawData, dim, 1, u_isoValue * 255);
  
    const triangleCount = fullGeometry.index
      ? fullGeometry.index.count / 3
      : fullGeometry.attributes.position.count / 3;
  
    const maxTriangles = 80000;
  
    const exporter = new STLExporter();
  
    if (triangleCount > maxTriangles) {
      // If too large, split then recombine:
      const chunks = splitBufferGeometry(fullGeometry, maxTriangles);
  
      const mergedGeometry = BufferGeometryUtils.mergeGeometries(chunks, true);
  
      const stlString = exporter.parse(
        new THREE.Mesh(mergedGeometry, new THREE.MeshBasicMaterial()),
        { binary: true }
      );
  
      const blob = new Blob([stlString], { type: "text/plain" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "mesh.stl";
      link.click();
    } else {
      // Small enough: export directly
      const stlString = exporter.parse(
        new THREE.Mesh(fullGeometry, new THREE.MeshBasicMaterial()),
        { binary: true }
      );
  
      const blob = new Blob([stlString], { type: "text/plain" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "mesh_" + Date.now() + ".stl";
      link.click()
    }
  }, [rawData, u_isoValue]);
  
  // Combine uniform overrides in an object that is memoized if needed
  const uniformsOverrides = { 
    u_dt, u_color, 
    u_alphaVal, 
    u_isoValue, 
    u_crossSectionSize, 
    u_renderMode: renderMode === "volume" ? 1.0 : 0.0,
  };

  // if (loading) {
  //   return (
  //     <div
  //       style={{
  //         display: "flex",
  //         justifyContent: "center",
  //         alignItems: "center",
  //         height: "100vh",
  //         background: "#fff",
  //         color: "#000",
  //       }}
  //     >
  //       <h1>Setting Up Volumetric Sandbox</h1>
  //     </div>
  //   );
  // }

  return (
    <div className="app-container">
      <div className="header">
        <div className="header-left">
          <h1 className="title">Implicit Surface Sandbox</h1>
          <span className="about">about</span>
        </div>
        <img src="/logo.svg" alt="Logo" className="logo" />
      </div>
      <Split
        className="split-container"
        sizes={[42, 58]}
        minSize={200}
        gutterSize={8}
        // snapOffset={30}
      >
        {/* LEFT: Editor */}
        <div className="editor-panel">
          <CodeEditor initialCode={DEFAULT_PYTHON_CODE} ref={editorRef} />

          <div style={{
            position: "absolute",
            bottom: "15px",
            right: "20px",
            zIndex: 10,
          }}>
            <button
              onClick={handleRunCode}
              style={{
                padding: "8px 12px",
                cursor: "pointer",
                background: "rgb(225, 255, 0)",
                color: "#000",
                borderRadius: "6px",
                fontSize: "20px"
              }}
            >
              Evaluate Python
            </button>
          </div>
        </div>

      {/* RIGHT: Canvas + controls */}
      <div className="canvas-panel">
        <ThreeCanvas rawData={rawData} uniformsOverrides={uniformsOverrides} />

        {loading && (
          <div style={{
            position: "absolute",
            top: 0, left: 0, right: 0, bottom: 0,
            background: "rgb(225, 255, 0, 0.5)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 1000,
          }}>
            <BounceLoader size={200} color={"rgb(225, 255, 0)"} />
          </div>
        )}

        {!loading && (
          <div style={{
              position: "absolute",
              bottom: "15px",
              right: "20px",
              zIndex: 10,
            }}>
              <button
                onClick={handleSaveMesh}
                style={{
                  padding: "8px 12px",
                  cursor: "pointer",
                  background: "rgb(225, 255, 0)",
                  color: "#000",
                  borderRadius: "6px",
                  fontSize: "20px"
                }}
              >
                Save Mesh
              </button>
            </div>
          )}

          {!loading && showControls && (
            <div
              className="control-panel"
              style={{
                position: "absolute",
                top: "12px",
                right: "12px",
                background: "rgba(42, 42, 42, 0.95)",
                padding: "16px",
                borderRadius: "10px",
                boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
                zIndex: 100,
                maxWidth: "300px",
                width: "fit-content",
              }}
            >
              <button
                onClick={() => setShowControls(false)}
                style={{
                  position: "absolute",
                  top: "6px",
                  right: "6px",
                  background: "transparent",
                  border: "none",
                  fontSize: "18px",
                  color: "#888",
                  cursor: "pointer",
                }}
                title="Close"
              >
                ✕
              </button>

              <div style={{ marginBottom: "12px" }}>
                <button
                  onClick={() => setUColor(0)}
                  style={{ marginRight: "8px", padding: "6px 12px", cursor: "pointer" }}
                >
                  Normal
                </button>
                <button
                  onClick={() => setUColor(1)}
                  style={{ padding: "6px 12px", cursor: "pointer" }}
                >
                  Phong
                </button>
              </div>

              <div style={{ marginBottom: "12px" }}>
                <label>
                  <input
                    type="radio"
                    name="renderMode"
                    value="volume"
                    checked={renderMode === "volume"}
                    onChange={() => setRenderMode("volume")}
                  />
                  Volume
                </label>
                <label style={{ marginLeft: "10px" }}>
                  <input
                    type="radio"
                    name="renderMode"
                    value="surface"
                    checked={renderMode === "surface"}
                    onChange={() => setRenderMode("surface")}
                  />
                  Surface
                </label>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <label>
                  Step Size:
                  <input
                    type="range"
                    min="0.001"
                    max="0.016"
                    step="0.002"
                    value={u_dt}
                    onChange={(e) => setUDt(parseFloat(e.target.value))}
                  />
                  <span style={{ 
                    display: "inline-block", 
                    width: "3ch", 
                    textAlign: "right", 
                    fontFamily: "monospace" 
                  }}>
                    {u_dt}
                  </span>
                </label>

                <label>
                  Alpha:
                  <input
                    type="range"
                    min="0.00"
                    max="2.0"
                    step="0.01"
                    value={u_alphaVal}
                    onChange={(e) => setUAlphaVal(parseFloat(e.target.value))}
                  />
                  <span style={{ 
                    display: "inline-block", 
                    width: "3ch", 
                    textAlign: "right", 
                    fontFamily: "monospace" 
                  }}>
                    {u_alphaVal}
                  </span>
                </label>

                <label>
                  Iso Value:
                  <input
                    type="range"
                    min="-1"
                    max="1"
                    step="0.01"
                    value={u_isoValue}
                    onChange={(e) => setUIsoValue(parseFloat(e.target.value))}
                  />
                  <span style={{ 
                    display: "inline-block", 
                    width: "3ch", 
                    textAlign: "right", 
                    fontFamily: "monospace" 
                  }}>
                    {u_isoValue}
                  </span>
                </label>

                <label>
                  X Section:
                  <input
                    type="range"
                    min="0.02"
                    max="0.5"
                    step="0.02"
                    value={u_crossSectionSize.x}
                    onChange={(e) =>
                      setUCrossSectionSize({
                        ...u_crossSectionSize,
                        x: parseFloat(e.target.value),
                      })
                    }
                  />
                  <span style={{ 
                    display: "inline-block", 
                    width: "3ch", 
                    textAlign: "right", 
                    fontFamily: "monospace" 
                  }}>
                    {u_crossSectionSize.x}
                  </span>
                </label>

                <label>
                  Y Section:
                  <input
                    type="range"
                    min="0.02"
                    max="0.5"
                    step="0.02"
                    value={u_crossSectionSize.y}
                    onChange={(e) =>
                      setUCrossSectionSize({
                        ...u_crossSectionSize,
                        y: parseFloat(e.target.value),
                      })
                    }
                  />
                  <span style={{ 
                    display: "inline-block", 
                    width: "3ch", 
                    textAlign: "right", 
                    fontFamily: "monospace" 
                  }}>
                    {u_crossSectionSize.y}
                  </span>
                </label>

                <label>
                  Z Section:
                  <input
                    type="range"
                    min="0.02"
                    max="0.5"
                    step="0.02"
                    value={u_crossSectionSize.z}
                    onChange={(e) =>
                      setUCrossSectionSize({
                        ...u_crossSectionSize,
                        z: parseFloat(e.target.value),
                      })
                    }
                  />
                  <span style={{ 
                    display: "inline-block", 
                    width: "3ch", 
                    textAlign: "right", 
                    fontFamily: "monospace" 
                  }}>
                    {u_crossSectionSize.z}
                  </span>
                </label>
              </div>
            </div>
          )}

          {!showControls && (
            <button
              onClick={() => setShowControls(true)}
              style={{
                position: "absolute",
                top: "12px",
                right: "12px",
                background: "rgba(30,30,30,0.85)",
                color: "#fff",
                border: "none",
                borderRadius: "6px",
                padding: "8px 12px",
                cursor: "pointer",
                zIndex: 10,
              }}
            >
              ⚙ Controls
            </button>
          )}

        </div>
        </Split>
      </div>

  );
};

export default App;
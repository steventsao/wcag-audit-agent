package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	maxPdfBytes   = 100 << 20 // 100 MB
	mutoolTimeout = 60 * time.Second
)

// POST /render?page=N&dpi=150
// Body: raw PDF bytes
// Response headers: X-Total-Pages: N
// Response body:    image/png, the rendered page
func render(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxPdfBytes)

	page := 1
	if p := r.URL.Query().Get("page"); p != "" {
		if n, err := strconv.Atoi(p); err == nil && n > 0 {
			page = n
		}
	}
	dpi := 150
	if d := r.URL.Query().Get("dpi"); d != "" {
		if n, err := strconv.Atoi(d); err == nil && n >= 50 && n <= 600 {
			dpi = n
		}
	}

	inFile, err := os.CreateTemp("", "in-*.pdf")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer os.Remove(inFile.Name())

	if _, err := io.Copy(inFile, r.Body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	inFile.Close()

	// Read page count first (also validates the PDF).
	totalPages, err := mutoolPageCount(r.Context(), inFile.Name())
	if err != nil {
		http.Error(w, "mutool info: "+err.Error(), 500)
		return
	}
	if page < 1 || page > totalPages {
		http.Error(w, fmt.Sprintf("page %d out of range 1..%d", page, totalPages), 400)
		return
	}

	outPath := inFile.Name() + ".png"
	defer os.Remove(outPath)

	ctx, cancel := context.WithTimeout(r.Context(), mutoolTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "mutool", "draw",
		"-r", strconv.Itoa(dpi),
		"-F", "png",
		"-o", outPath,
		inFile.Name(),
		strconv.Itoa(page),
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			http.Error(w, "mutool draw timed out", http.StatusGatewayTimeout)
			return
		}
		http.Error(w, fmt.Sprintf("mutool draw failed: %s\n%s", err, out), 500)
		return
	}

	data, err := os.ReadFile(outPath)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	// Optional bbox crop. `crop=ymin,xmin,ymax,xmax` normalized 0–1000 (Gemini order).
	// Backward compatible: absent → return the whole-page PNG unchanged (byte-identical to before).
	if cropStr := r.URL.Query().Get("crop"); cropStr != "" {
		if cropped, cerr := cropPNG(data, cropStr); cerr == nil {
			data = cropped
		} else {
			// Never fail the render over a bad crop — fall back to the full page.
			fmt.Printf("crop skipped (%v) for crop=%q\n", cerr, cropStr)
		}
	}

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("X-Total-Pages", strconv.Itoa(totalPages))
	w.Write(data)
}

// cropPNG crops a sub-rectangle out of a PNG. `cropStr` is "ymin,xmin,ymax,xmax" normalized to 0–1000
// (Gemini-native bbox order/space). Pixel rect = norm/1000 × image dims, with ~2% padding, clamped to
// bounds. Returns a freshly-encoded PNG of just that region.
func cropPNG(pngData []byte, cropStr string) ([]byte, error) {
	parts := strings.Split(cropStr, ",")
	if len(parts) != 4 {
		return nil, fmt.Errorf("crop needs 4 values, got %d", len(parts))
	}
	v := make([]float64, 4)
	for i, p := range parts {
		f, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			return nil, fmt.Errorf("bad crop value %q: %w", p, err)
		}
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, fmt.Errorf("non-finite crop value %q", p)
		}
		v[i] = f
	}
	ymin, xmin, ymax, xmax := v[0], v[1], v[2], v[3]
	img, err := png.Decode(bytes.NewReader(pngData))
	if err != nil {
		return nil, fmt.Errorf("png decode: %w", err)
	}
	b := img.Bounds()
	fw, fh := float64(b.Dx()), float64(b.Dy())
	const pad = 0.02 // VLM bboxes run a touch tight on charts; pad so we don't clip axes/labels.
	x0 := int(math.Max(0, (xmin/1000.0-pad)*fw))
	y0 := int(math.Max(0, (ymin/1000.0-pad)*fh))
	x1 := int(math.Min(fw, (xmax/1000.0+pad)*fw))
	y1 := int(math.Min(fh, (ymax/1000.0+pad)*fh))
	if x1 <= x0 || y1 <= y0 {
		return nil, fmt.Errorf("empty crop rect [%d,%d,%d,%d]", x0, y0, x1, y1)
	}
	rect := image.Rect(0, 0, x1-x0, y1-y0)
	dst := image.NewRGBA(rect)
	draw.Draw(dst, rect, img, image.Pt(b.Min.X+x0, b.Min.Y+y0), draw.Src)
	var buf bytes.Buffer
	if err := png.Encode(&buf, dst); err != nil {
		return nil, fmt.Errorf("png encode: %w", err)
	}
	return buf.Bytes(), nil
}

// POST /text?page=N
// Body: raw PDF bytes
// Response headers: X-Total-Pages: N
// Response body:    text/plain, text extracted from the requested page
func text(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxPdfBytes)

	page := 1
	if p := r.URL.Query().Get("page"); p != "" {
		if n, err := strconv.Atoi(p); err == nil && n > 0 {
			page = n
		}
	}

	inFile, err := os.CreateTemp("", "in-*.pdf")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer os.Remove(inFile.Name())

	if _, err := io.Copy(inFile, r.Body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	inFile.Close()

	totalPages, err := mutoolPageCount(r.Context(), inFile.Name())
	if err != nil {
		http.Error(w, "mutool info: "+err.Error(), 500)
		return
	}
	if page < 1 || page > totalPages {
		http.Error(w, fmt.Sprintf("page %d out of range 1..%d", page, totalPages), 400)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), mutoolTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "mutool", "draw",
		"-F", "txt",
		inFile.Name(),
		strconv.Itoa(page),
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			http.Error(w, "mutool text extraction timed out", http.StatusGatewayTimeout)
			return
		}
		http.Error(w, fmt.Sprintf("mutool draw -F txt failed: %s\n%s", err, out), 500)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Total-Pages", strconv.Itoa(totalPages))
	w.Write(out)
}

type normBBox struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

type textSearchMatch struct {
	Text   string   `json:"text"`
	BBox   normBBox `json:"bbox"`
	Source string   `json:"source"`
	area   float64
}

type rawBBox struct {
	X0 float64
	Y0 float64
	X1 float64
	Y1 float64
}

// POST /search-text?page=N&query=needle
// Body: raw PDF bytes
// Response: {"totalPages":N,"matches":[{"text":"...","bbox":{x,y,w,h},"source":"pdf_text_layer"}]}
func searchText(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxPdfBytes)

	query := strings.TrimSpace(r.URL.Query().Get("query"))
	if query == "" {
		query = strings.TrimSpace(r.URL.Query().Get("q"))
	}
	if query == "" {
		http.Error(w, "query is required", http.StatusBadRequest)
		return
	}

	page := 1
	if p := r.URL.Query().Get("page"); p != "" {
		if n, err := strconv.Atoi(p); err == nil && n > 0 {
			page = n
		}
	}

	inFile, err := os.CreateTemp("", "in-*.pdf")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer os.Remove(inFile.Name())

	if _, err := io.Copy(inFile, r.Body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	inFile.Close()

	totalPages, err := mutoolPageCount(r.Context(), inFile.Name())
	if err != nil {
		http.Error(w, "mutool info: "+err.Error(), 500)
		return
	}
	if page < 1 || page > totalPages {
		http.Error(w, fmt.Sprintf("page %d out of range 1..%d", page, totalPages), 400)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), mutoolTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "mutool", "draw",
		"-F", "stext.json",
		inFile.Name(),
		strconv.Itoa(page),
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			http.Error(w, "mutool structured text extraction timed out", http.StatusGatewayTimeout)
			return
		}
		http.Error(w, fmt.Sprintf("mutool draw -F stext.json failed: %s\n%s", err, out), 500)
		return
	}

	var parsed any
	if err := json.Unmarshal(out, &parsed); err != nil {
		http.Error(w, "parse stext.json: "+err.Error(), 500)
		return
	}

	matches := findTextLayerMatches(parsed, query)
	if len(matches) > 20 {
		matches = matches[:20]
	}
	publicMatches := make([]textSearchMatch, len(matches))
	for i, match := range matches {
		publicMatches[i] = textSearchMatch{Text: match.Text, BBox: match.BBox, Source: match.Source}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"totalPages": totalPages,
		"matches":    publicMatches,
	})
}

func findTextLayerMatches(parsed any, query string) []textSearchMatch {
	needle := strings.ToLower(strings.TrimSpace(query))
	if needle == "" {
		return nil
	}

	var pages []any
	if root, ok := parsed.(map[string]any); ok {
		if rawPages, ok := root["pages"].([]any); ok {
			pages = rawPages
		}
	}
	if len(pages) == 0 {
		pages = []any{parsed}
	}

	var candidates []textSearchMatch
	for _, page := range pages {
		pageMap, _ := page.(map[string]any)
		pageBox := pageBounds(pageMap)
		walkTextLayer(page, pageBox, needle, &candidates)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return candidates[i].area < candidates[j].area
	})

	seen := map[string]bool{}
	out := make([]textSearchMatch, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.BBox.W <= 0 || candidate.BBox.H <= 0 {
			continue
		}
		key := fmt.Sprintf("%.4f:%.4f:%.4f:%.4f", candidate.BBox.X, candidate.BBox.Y, candidate.BBox.W, candidate.BBox.H)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, candidate)
		if len(out) >= 20 {
			break
		}
	}
	return out
}

func walkTextLayer(value any, pageBox rawBBox, needle string, out *[]textSearchMatch) {
	switch v := value.(type) {
	case []any:
		for _, child := range v {
			walkTextLayer(child, pageBox, needle, out)
		}
	case map[string]any:
		if bbox, ok := parseBBox(v["bbox"]); ok {
			text := strings.Join(collectText(v), " ")
			if strings.Contains(strings.ToLower(text), needle) {
				if norm, ok := normalizeBBox(bbox, pageBox); ok {
					*out = append(*out, textSearchMatch{
						Text:   strings.TrimSpace(text),
						BBox:   norm,
						Source: "pdf_text_layer",
						area:   norm.W * norm.H,
					})
				}
			}
		}
		for _, child := range v {
			walkTextLayer(child, pageBox, needle, out)
		}
	}
}

func pageBounds(page map[string]any) rawBBox {
	if page != nil {
		for _, key := range []string{"mediabox", "mediaBox", "cropbox", "cropBox", "bbox"} {
			if bbox, ok := parseBBox(page[key]); ok && bbox.X1 > bbox.X0 && bbox.Y1 > bbox.Y0 {
				return bbox
			}
		}
	}
	return rawBBox{X0: 0, Y0: 0, X1: 612, Y1: 792}
}

func collectText(value any) []string {
	switch v := value.(type) {
	case string:
		if strings.TrimSpace(v) == "" {
			return nil
		}
		return []string{v}
	case []any:
		var out []string
		for _, child := range v {
			out = append(out, collectText(child)...)
		}
		return out
	case map[string]any:
		var out []string
		for key, child := range v {
			switch strings.ToLower(key) {
			case "bbox", "mediabox", "mediaboxes", "color", "font", "size", "x", "y", "w", "h", "width", "height":
				continue
			}
			out = append(out, collectText(child)...)
		}
		return out
	default:
		return nil
	}
}

func parseBBox(value any) (rawBBox, bool) {
	switch v := value.(type) {
	case []any:
		if len(v) < 4 {
			return rawBBox{}, false
		}
		x0, ok0 := asFloat(v[0])
		y0, ok1 := asFloat(v[1])
		x1, ok2 := asFloat(v[2])
		y1, ok3 := asFloat(v[3])
		if !ok0 || !ok1 || !ok2 || !ok3 {
			return rawBBox{}, false
		}
		return rawBBox{X0: math.Min(x0, x1), Y0: math.Min(y0, y1), X1: math.Max(x0, x1), Y1: math.Max(y0, y1)}, true
	case map[string]any:
		if x0, ok0 := firstFloat(v, "x0", "left"); ok0 {
			if y0, ok1 := firstFloat(v, "y0", "top"); ok1 {
				if x1, ok2 := firstFloat(v, "x1", "right"); ok2 {
					if y1, ok3 := firstFloat(v, "y1", "bottom"); ok3 {
						return rawBBox{X0: math.Min(x0, x1), Y0: math.Min(y0, y1), X1: math.Max(x0, x1), Y1: math.Max(y0, y1)}, true
					}
				}
			}
		}
		x, ok0 := firstFloat(v, "x")
		y, ok1 := firstFloat(v, "y")
		w, ok2 := firstFloat(v, "w", "width")
		h, ok3 := firstFloat(v, "h", "height")
		if !ok0 || !ok1 || !ok2 || !ok3 || w <= 0 || h <= 0 {
			return rawBBox{}, false
		}
		return rawBBox{X0: x, Y0: y, X1: x + w, Y1: y + h}, true
	default:
		return rawBBox{}, false
	}
}

func normalizeBBox(bbox rawBBox, page rawBBox) (normBBox, bool) {
	pageW := page.X1 - page.X0
	pageH := page.Y1 - page.Y0
	if pageW <= 0 || pageH <= 0 || bbox.X1 <= bbox.X0 || bbox.Y1 <= bbox.Y0 {
		return normBBox{}, false
	}
	x := (bbox.X0 - page.X0) / pageW
	y := (bbox.Y0 - page.Y0) / pageH
	w := (bbox.X1 - bbox.X0) / pageW
	h := (bbox.Y1 - bbox.Y0) / pageH
	x = math.Max(0, math.Min(1, x))
	y = math.Max(0, math.Min(1, y))
	w = math.Max(0, math.Min(1-x, w))
	h = math.Max(0, math.Min(1-y, h))
	return normBBox{X: x, Y: y, W: w, H: h}, w > 0 && h > 0
}

func firstFloat(raw map[string]any, keys ...string) (float64, bool) {
	for _, key := range keys {
		if n, ok := asFloat(raw[key]); ok {
			return n, true
		}
	}
	return 0, false
}

func asFloat(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case json.Number:
		n, err := v.Float64()
		return n, err == nil
	default:
		return 0, false
	}
}

// POST /pages — body: PDF bytes → {"pages": N}.
// Kept as a standalone helper; `/render` also returns X-Total-Pages.
func pages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only (PDF in body)", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxPdfBytes)

	inFile, err := os.CreateTemp("", "in-*.pdf")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer os.Remove(inFile.Name())
	if _, err := io.Copy(inFile, r.Body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	inFile.Close()

	n, err := mutoolPageCount(r.Context(), inFile.Name())
	if err != nil {
		http.Error(w, "mutool info: "+err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"pages":%d}`, n)
}

// mutoolPageCount runs `mutool info` and parses the "Pages: N" line.
// `mutool info` prints several lines (PDF-1.x, Title:, …, Pages: N) — we scan for the match.
func mutoolPageCount(parent context.Context, path string) (int, error) {
	ctx, cancel := context.WithTimeout(parent, mutoolTimeout)
	defer cancel()

	out, err := exec.CommandContext(ctx, "mutool", "info", path).CombinedOutput()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return 0, fmt.Errorf("timed out")
		}
		return 0, fmt.Errorf("%s: %s", err, strings.TrimSpace(string(out)))
	}
	for _, line := range strings.Split(string(out), "\n") {
		var n int
		if _, e := fmt.Sscanf(strings.TrimSpace(line), "Pages: %d", &n); e == nil && n > 0 {
			return n, nil
		}
	}
	return 0, fmt.Errorf("no Pages line in mutool info output: %s", strings.TrimSpace(string(out)))
}

func health(w http.ResponseWriter, _ *http.Request) {
	w.Write([]byte("ok"))
}

func main() {
	// Log mutool version at startup — useful for debugging rendering diffs across builds.
	if out, err := exec.Command("mutool", "-v").CombinedOutput(); err == nil {
		fmt.Printf("mutool: %s", string(out))
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/render", render)
	mux.HandleFunc("/text", text)
	mux.HandleFunc("/search-text", searchText)
	mux.HandleFunc("/pages", pages)
	mux.HandleFunc("/_health", health)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	fmt.Printf("pdf-rasterizer listening on :%s\n", port)
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		panic(err)
	}
}

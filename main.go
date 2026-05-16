package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gomarkdown/markdown"
	"github.com/gomarkdown/markdown/html"
	"github.com/gomarkdown/markdown/parser"
)

const (
	notesDir   = "notes"
	uploadsDir = "notes/uploads"
	port       = "8080"
)

// version is set at build time via -ldflags "-X main.version=vX.Y.Z"
var version = "v1.1.0"

// ── Auth ──────────────────────────────────────────────────────────────────────

var (
	authUser   string
	authPass   string
	sessions   = map[string]time.Time{} // token → expiry
	sessionsMu sync.Mutex
)

func newSessionToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func isAuthenticated(r *http.Request) bool {
	cookie, err := r.Cookie("session")
	if err != nil {
		return false
	}
	sessionsMu.Lock()
	exp, ok := sessions[cookie.Value]
	if ok && time.Now().After(exp) {
		delete(sessions, cookie.Value)
		ok = false
	}
	sessionsMu.Unlock()
	return ok
}

func handleVersion(w http.ResponseWriter, r *http.Request) {
	jsonHeader(w)
	json.NewEncoder(w).Encode(map[string]string{"version": version})
}

func requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if authPass == "" || r.URL.Path == "/login" || r.URL.Path == "/api/version" || isAuthenticated(r) {
			next.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		http.Redirect(w, r, "/login", http.StatusSeeOther)
	})
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		http.ServeFile(w, r, filepath.Join("static", "login.html"))
	case http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		userOK := subtle.ConstantTimeCompare([]byte(r.FormValue("username")), []byte(authUser)) == 1
		passOK := subtle.ConstantTimeCompare([]byte(r.FormValue("password")), []byte(authPass)) == 1
		if userOK && passOK {
			token := newSessionToken()
			sessionsMu.Lock()
			sessions[token] = time.Now().Add(7 * 24 * time.Hour)
			sessionsMu.Unlock()
			http.SetCookie(w, &http.Cookie{
				Name:     "session",
				Value:    token,
				HttpOnly: true,
				SameSite: http.SameSiteStrictMode,
				Path:     "/",
			})
			http.Redirect(w, r, "/", http.StatusSeeOther)
		} else {
			http.Redirect(w, r, "/login?error=1", http.StatusSeeOther)
		}
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie("session"); err == nil {
		sessionsMu.Lock()
		delete(sessions, cookie.Value)
		sessionsMu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: "session", Value: "", MaxAge: -1, Path: "/"})
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

// ── Notes ─────────────────────────────────────────────────────────────────────

type Note struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Content  string    `json:"content"`
	Tags     []string  `json:"tags"`
	Created  time.Time `json:"created"`
	Modified time.Time `json:"modified"`
}

func renderMarkdown(md string) string {
	extensions := parser.CommonExtensions | parser.AutoHeadingIDs | parser.NoEmptyLineBeforeBlock
	p := parser.NewWithExtensions(extensions)
	doc := p.Parse([]byte(md))
	flags := html.CommonFlags | html.HrefTargetBlank | html.NoopenerLinks | html.NoreferrerLinks
	opts := html.RendererOptions{Flags: flags}
	renderer := html.NewRenderer(opts)
	return string(markdown.Render(doc, renderer))
}

func listNotes() ([]Note, error) {
	entries, err := os.ReadDir(notesDir)
	if err != nil {
		return nil, err
	}
	var notes []Note
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(notesDir, entry.Name()))
		if err != nil {
			continue
		}
		var note Note
		if json.Unmarshal(data, &note) != nil {
			continue
		}
		notes = append(notes, note)
	}
	sort.Slice(notes, func(i, j int) bool {
		return notes[i].Modified.After(notes[j].Modified)
	})
	return notes, nil
}

func getNote(id string) (Note, error) {
	data, err := os.ReadFile(filepath.Join(notesDir, id+".json"))
	if err != nil {
		return Note{}, err
	}
	var note Note
	return note, json.Unmarshal(data, &note)
}

func saveNote(note Note) error {
	data, err := json.Marshal(note)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(notesDir, note.ID+".json"), data, 0644)
}

func deleteNote(id string) error {
	return os.Remove(filepath.Join(notesDir, id+".json"))
}

func isValidNoteID(id string) bool {
	if id == "" {
		return false
	}
	for _, c := range id {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// ── Middleware ────────────────────────────────────────────────────────────────

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func jsonHeader(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
}

// ── Handlers ──────────────────────────────────────────────────────────────────

func handleNotes(w http.ResponseWriter, r *http.Request) {
	jsonHeader(w)
	switch r.Method {
	case http.MethodGet:
		notes, err := listNotes()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if notes == nil {
			notes = []Note{}
		}
		json.NewEncoder(w).Encode(notes)
	case http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, 2<<20) // 2 MB
		var note Note
		if err := json.NewDecoder(r.Body).Decode(&note); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		note.ID = fmt.Sprintf("%d", time.Now().UnixNano())
		note.Created = time.Now()
		note.Modified = time.Now()
		if note.Title == "" {
			note.Title = "Untitled Note"
		}
		if err := saveNote(note); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(note)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleNote(w http.ResponseWriter, r *http.Request) {
	jsonHeader(w)
	id := strings.TrimPrefix(r.URL.Path, "/api/notes/")
	if !isValidNoteID(id) {
		http.Error(w, "invalid note ID", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodGet:
		note, err := getNote(id)
		if err != nil {
			if os.IsNotExist(err) {
				http.Error(w, "Note not found", http.StatusNotFound)
			} else {
				http.Error(w, err.Error(), http.StatusInternalServerError)
			}
			return
		}
		json.NewEncoder(w).Encode(note)
	case http.MethodPut:
		r.Body = http.MaxBytesReader(w, r.Body, 2<<20) // 2 MB
		var update Note
		if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		note, err := getNote(id)
		if err != nil {
			http.Error(w, "Note not found", http.StatusNotFound)
			return
		}
		note.Title = update.Title
		note.Content = update.Content
		note.Tags = update.Tags
		note.Modified = time.Now()
		if err := saveNote(note); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(note)
	case http.MethodDelete:
		if err := deleteNote(id); err != nil {
			if os.IsNotExist(err) {
				http.Error(w, "Note not found", http.StatusNotFound)
			} else {
				http.Error(w, err.Error(), http.StatusInternalServerError)
			}
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20) // 10 MB
	if err := r.ParseMultipartForm(10 << 20); err != nil {
		http.Error(w, "file too large", http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("image")
	if err != nil {
		http.Error(w, "missing image field", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Read first 512 bytes to detect MIME type
	buf := make([]byte, 512)
	n, _ := file.Read(buf)
	mimeType := http.DetectContentType(buf[:n])
	if !strings.HasPrefix(mimeType, "image/") {
		http.Error(w, "only image files are allowed", http.StatusBadRequest)
		return
	}

	// Build a collision-safe filename: timestamp + original name
	ext := strings.ToLower(filepath.Ext(header.Filename))
	allowedExts := map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true, ".svg": true}
	if !allowedExts[ext] {
		http.Error(w, "unsupported image type", http.StatusBadRequest)
		return
	}
	filename := fmt.Sprintf("%d%s", time.Now().UnixNano(), ext)
	dest := filepath.Join(uploadsDir, filename)

	out, err := os.Create(dest)
	if err != nil {
		http.Error(w, "could not save file", http.StatusInternalServerError)
		return
	}
	defer out.Close()

	// Write the sniffed bytes first, then the rest
	if _, err = out.Write(buf[:n]); err != nil {
		http.Error(w, "write error", http.StatusInternalServerError)
		return
	}
	if _, err = io.Copy(out, file); err != nil {
		http.Error(w, "write error", http.StatusInternalServerError)
		return
	}

	jsonHeader(w)
	json.NewEncoder(w).Encode(map[string]string{"url": "/uploads/" + filename})
}

func handleRender(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MB
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	jsonHeader(w)
	json.NewEncoder(w).Encode(map[string]string{"html": renderMarkdown(req.Content)})
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	authUser = os.Getenv("AUTH_USER")
	if authUser == "" {
		authUser = "admin"
	}
	authPass = os.Getenv("AUTH_PASS")
	if authPass == "" {
		log.Println("WARNING: AUTH_PASS not set — running without authentication")
	}

	go func() {
		for range time.Tick(1 * time.Hour) {
			sessionsMu.Lock()
			for tok, exp := range sessions {
				if time.Now().After(exp) {
					delete(sessions, tok)
				}
			}
			sessionsMu.Unlock()
		}
	}()

	if err := os.MkdirAll(notesDir, 0755); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(uploadsDir, 0755); err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/login", handleLogin)
	mux.HandleFunc("/logout", handleLogout)
	mux.HandleFunc("/api/version", handleVersion)
	mux.HandleFunc("/api/notes", handleNotes)
	mux.HandleFunc("/api/notes/", handleNote)
	mux.HandleFunc("/api/render", handleRender)
	mux.HandleFunc("/api/upload", handleUpload)
	mux.Handle("/uploads/", http.StripPrefix("/uploads/", http.FileServer(http.Dir(uploadsDir))))
	mux.Handle("/", http.FileServer(http.Dir("static")))

	fmt.Printf("Urban Notes %s running at http://localhost:%s\n", version, port)
	log.Fatal(http.ListenAndServe(":"+port, securityHeaders(requireAuth(mux))))
}

# CoFilm

A static web page that turns a OneDrive shared folder into a movie library and plays MKV/HEVC files in the browser (Movi Player). Metadata comes from TMDB and Cinemeta; IMDb / Rotten Tomatoes / Douban ratings are refreshed every 6 hours by a GitHub Action.

Private data is never stored in plain text here: the OneDrive link and TMDB key live in GitHub Actions secrets, and `config.enc.json` / `ratings.enc.json` are AES-GCM encrypted.

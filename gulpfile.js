"use strict";

const gulp = require("gulp");
const uglify = require("gulp-uglify");
const cleanCSS = require("gulp-clean-css");
const rename = require("gulp-rename");

// Task: Process JavaScript
// Reads the JS file, writes unminified version to /dist,
// then uglifies and writes the minified version.
gulp.task("js", function () {
return gulp
.src("src/voice-chat-lib.js")
.pipe(gulp.dest("dist"))
.pipe(uglify())
.pipe(rename({ suffix: ".min" }))
.pipe(gulp.dest("dist"));
});

// Task: Process CSS
// Reads the CSS file, writes unminified version to /dist,
// then minifies and writes the minified version.
gulp.task("css", function () {
return gulp
.src("css/voice-chat-lib.css")
.pipe(gulp.dest("dist"))
.pipe(cleanCSS())
.pipe(rename({ suffix: ".min" }))
.pipe(gulp.dest("dist"));
});

// Default task: run both "js" and "css" tasks in parallel.
gulp.task("default", gulp.parallel("js", "css"));
"use strict";

var VoiceChatLib = (function () {
  var instance; // Singleton instance

  // Helper: get a DOM element from a parameter.
  function getElement(param, defaultSelector) {
    if (param) {
      if (typeof param === "string") {
        return document.querySelector(param);
      } else {
        return param;
      }
    }
    return document.querySelector(defaultSelector);
  }

  // Helper: get multiple elements.
  function getElementList(param, defaultSelector) {
    if (param) {
      if (typeof param === "string") {
        return document.querySelectorAll(param);
      } else {
        return param;
      }
    }
    return document.querySelectorAll(defaultSelector);
  }

  // Constructor function.
  function VoiceChat(options) {
    // Default configurable constants.
    this.config = {
      amplitudeSmoothFactorVar: 0.3, // Smoothing factor (0–1)
      baseRotationDivisor: 16, // Divisor for base rotation speed (lower = faster)
      dynamicLerpMin: 0.05, // Minimum lerp factor when quiet
      dynamicLerpAudioMultiplier: 0.5, // Additional lerp boost per audio level
      maxAdditionalRotation: 360, // Maximum extra rotation (degrees) when audio is strong
      baseScaleMultiplier: 2.0, // Factor controlling how much scale increases with audio
      // Elements can be passed in as selectors or DOM element references.
      elements: {
        toggleBtn: "#toggleMicBtn",
        endBtn: "#endChatBtn",
        voiceEls: ".a-cue-voice-el"
      }
    };
    if (options) {
      for (var key in options) {
        if (options.hasOwnProperty(key)) {
          if (key === "elements") {
            for (var subKey in options.elements) {
              if (options.elements.hasOwnProperty(subKey)) {
                this.config.elements[subKey] = options.elements[subKey];
              }
            }
          } else {
            this.config[key] = options[key];
          }
        }
      }
    }

    // Audio and animation properties.
    this.audioStream = null;
    this.audioContext = null;
    this.analyser = null;
    this.microphone = null;
    this.animationId = null;
    this.isMicOn = true;
    this.smoothedAmplitude = 0;

    // Timing controls.
    this.startTime = null;
    this.lastFrameTime = null;
    this.MAX_DELTA = 100;

    // DOM element references.
    this.voiceEls = [];
    this.toggleBtn = null;
    this.endBtn = null;

    // Flags.
    this.elementsBound = false;
    this.audioStarted = false;
    this.domObserver = null;

    // New properties for recording.
    this.mediaRecorder = null;
    this.recordedChunks = [];

    // Callback properties.
    this.onStart = null;
    this.onToggle = null;
    this.onEnd = null;

    // Flags for event binding.
    this.toggleBtnBound = false;
    this.endBtnBound = false;

    // Bind event handlers as named functions.
    var self = this;
    this.handleToggle = function (e) {
      e.preventDefault();
      self.toggleMic();
    };
    this.handleEnd = function (e) {
      e.preventDefault();
      self.end();
    };
  }

  // Update configuration options.
  VoiceChat.prototype.setOptions = function (options) {
    for (var key in options) {
      if (options.hasOwnProperty(key)) {
        if (key === "elements") {
          for (var subKey in options.elements) {
            if (options.elements.hasOwnProperty(subKey)) {
              this.config.elements[subKey] = options.elements[subKey];
            }
          }
        } else {
          this.config[key] = options[key];
        }
      }
    }
  };

  // Bind the UI elements.
  VoiceChat.prototype.initElements = function () {
    var elConfig = this.config.elements;
    this.toggleBtn = getElement(elConfig.toggleBtn, "#toggleMicBtn");
    this.endBtn = getElement(elConfig.endBtn, "#endChatBtn");
    this.voiceEls = getElementList(elConfig.voiceEls, ".a-cue-voice-el");

    var now = performance.now();
    for (var i = 0; i < this.voiceEls.length; i++) {
      var el = this.voiceEls[i];
      if (!el.initialized) {
        var offset = (Math.random() * 360).toFixed(0);
        var speed = (1 + Math.random() * 2).toFixed(2);
        var scaleMultiplier = (1 + Math.random() * 1.5).toFixed(2);
        el.dataset.offset = offset;
        el.dataset.speed = speed;
        el.dataset.scaleMultiplier = scaleMultiplier;
        var originX = (45 + Math.random() * 10).toFixed(0);
        var originY = (45 + Math.random() * 10).toFixed(0);
        el.style.transformOrigin = originX + "% " + originY + "%";
        if (this.audioStarted && typeof this.startTime === "number") {
          var effectiveTime = now - this.startTime;
          var baseRot =
            parseFloat(offset) +
            ((effectiveTime * parseFloat(speed)) / this.config.baseRotationDivisor);
          var addRot = this.smoothedAmplitude * this.config.maxAdditionalRotation;
          el.currentRotation = baseRot + addRot;
          var tarScale =
            1 + this.smoothedAmplitude * parseFloat(scaleMultiplier) * this.config.baseScaleMultiplier;
          el.currentScale = tarScale;
        } else {
          el.currentRotation = 0;
          el.currentScale = 1;
        }
        el.initialized = true;
      }
    }

    if (this.toggleBtn && !this.toggleBtnBound) {
      this.toggleBtn.addEventListener("click", this.handleToggle);
      this.toggleBtnBound = true;
    }
    if (this.endBtn && !this.endBtnBound) {
      this.endBtn.addEventListener("click", this.handleEnd);
      this.endBtnBound = true;
    }

    this.updateMicDisplay();
    this.elementsBound = true;
  };

  // Use a MutationObserver to rebind elements when the DOM changes.
  VoiceChat.prototype.observeDOM = function () {
    var self = this;
    if (!this.domObserver) {
      this.domObserver = new MutationObserver(function (mutationsList) {
        self.initElements();
      });
      this.domObserver.observe(document.body, { childList: true, subtree: true });
    }
  };

  // Update the toggle button display.
  VoiceChat.prototype.updateMicDisplay = function () {
    if (this.toggleBtn) {
      this.toggleBtn.classList.toggle("is--on", this.isMicOn);
      this.toggleBtn.classList.toggle("is--off", !this.isMicOn);
    }
  };

  // Linear interpolation.
  VoiceChat.prototype.lerp = function (start, end, factor) {
    return start + factor * (end - start);
  };

  // Initialize audio capture and immediately start recording.
  VoiceChat.prototype.initAudio = function () {
    var self = this;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(function (stream) {
        self.audioStream = stream;
        self.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        self.microphone = self.audioContext.createMediaStreamSource(stream);
        self.analyser = self.audioContext.createAnalyser();
        self.analyser.fftSize = 256;
        self.microphone.connect(self.analyser);

        var track = self.audioStream.getAudioTracks()[0];
        var micLabel = track && track.label ? track.label : "(unknown)";

        self.updateMicDisplay();

        self.startTime = performance.now();
        self.lastFrameTime = self.startTime;

        self.updateAnimation();
        self.audioStarted = true;

        if (window.MediaRecorder) {
          self.recordedChunks = [];
          try {
            self.mediaRecorder = new MediaRecorder(self.audioStream);
            self.mediaRecorder.ondataavailable = function (e) {
              if (e.data && e.data.size > 0) {
                self.recordedChunks.push(e.data);
              }
            };
            self.mediaRecorder.start();
          } catch (err) {
            console.error("MediaRecorder creation failed:", err);
          }
        } else {
          console.warn("MediaRecorder API not supported in this browser.");
        }

        if (typeof self.onStart === "function") {
          self.onStart({
            event: "start",
            timestamp: Date.now(),
            details: "VoiceChat audio and recording successfully started",
            isMicOn: self.isMicOn,
            microphoneLabel: micLabel
          });
        }
      })
      .catch(function (err) {
        console.error("Error accessing the microphone:", err);
        alert("Could not access the microphone. Check your permissions.");
      });
  };

  // Main animation loop.
  VoiceChat.prototype.updateAnimation = function () {
    var self = this;
    if (!self.analyser) return;
    var now = performance.now();
    if (!self.lastFrameTime) {
      self.lastFrameTime = now;
      self.startTime = now;
    }
    var delta = now - self.lastFrameTime;
    if (delta > self.MAX_DELTA) {
      self.startTime = now;
    }
    self.lastFrameTime = now;

    var dataArray = new Uint8Array(self.analyser.frequencyBinCount);
    self.analyser.getByteTimeDomainData(dataArray);
    var sum = 0;
    for (var i = 0; i < dataArray.length; i++) {
      sum += Math.abs(dataArray[i] - 128);
    }
    var average = sum / dataArray.length;
    var amplitudeNormalized = average / 128;
    self.smoothedAmplitude =
      self.smoothedAmplitude * (1 - self.config.amplitudeSmoothFactorVar) +
      amplitudeNormalized * self.config.amplitudeSmoothFactorVar;

    var effectiveTime = now - self.startTime;
    var dynamicLerpFactor =
      self.config.dynamicLerpMin +
      self.smoothedAmplitude * self.config.dynamicLerpAudioMultiplier;

    self.voiceEls.forEach(function (el) {
      var offset = parseFloat(el.dataset.offset);
      var speed = parseFloat(el.dataset.speed);
      var scaleMultiplier = parseFloat(el.dataset.scaleMultiplier);
      var baseRotation =
        offset + (effectiveTime * speed) / self.config.baseRotationDivisor;
      var additionalRotation =
        self.smoothedAmplitude * self.config.maxAdditionalRotation;
      var targetRotation = baseRotation + additionalRotation;
      var targetScale =
        1 +
        self.smoothedAmplitude * scaleMultiplier * self.config.baseScaleMultiplier;
      el.currentRotation = self.lerp(
        el.currentRotation,
        targetRotation,
        dynamicLerpFactor
      );
      el.currentScale = self.lerp(
        el.currentScale,
        targetScale,
        dynamicLerpFactor
      );
      el.style.transform =
        "rotate(" +
        el.currentRotation.toFixed(2) +
        "deg) scale(" +
        el.currentScale.toFixed(2) +
        ")";
    });

    self.animationId = requestAnimationFrame(function () {
      self.updateAnimation();
    });
  };

  // Toggle microphone on/off.
  VoiceChat.prototype.toggleMic = function () {
    var self = this;
    if (this.mediaRecorder) {
      if (this.isMicOn) {
        if (this.mediaRecorder.state === "recording") {
          this.mediaRecorder.pause();
        }
        this.isMicOn = false;
        if (this.audioStream) {
          this.audioStream.getAudioTracks().forEach(function (track) {
            track.enabled = false;
          });
        }
      } else {
        if (this.mediaRecorder.state === "paused") {
          this.mediaRecorder.resume();
        }
        this.isMicOn = true;
        if (this.audioStream) {
          this.audioStream.getAudioTracks().forEach(function (track) {
            track.enabled = true;
          });
        }
      }
    } else {
      if (this.audioStream && this.audioStream.getAudioTracks().length > 0) {
        this.isMicOn = !this.isMicOn;
        this.audioStream.getAudioTracks().forEach(function (track) {
          track.enabled = self.isMicOn;
        });
      }
    }
    this.updateMicDisplay();

    if (typeof self.onToggle === "function") {
      self.onToggle({
        event: "toggleMic",
        timestamp: Date.now(),
        isMicOn: self.isMicOn,
        details: "Microphone toggled"
      });
    }
  };

  // End the session.
  VoiceChat.prototype.end = function () {
    var self = this;
    if (this.animationId) cancelAnimationFrame(this.animationId);

    if (this.audioStream) {
      this.audioStream.getTracks().forEach(function (track) {
        track.stop();
      });
    }
    if (this.audioContext) this.audioContext.close();
    if (this.toggleBtn) this.toggleBtn.disabled = true;
    if (this.endBtn) this.endBtn.disabled = true;

    if (
      this.mediaRecorder &&
      (this.mediaRecorder.state === "recording" ||
        this.mediaRecorder.state === "paused")
    ) {
      this.mediaRecorder.onstop = function (e) {
        var blob = new Blob(self.recordedChunks, { type: "audio/webm" });
        var durationMs = performance.now() - self.startTime;

        var fileName =
          "voice-chat-" +
          Math.random().toString(36).substring(2, 10) +
          ".webm";

        function formatDuration(ms) {
          var totalSec = Math.floor(ms / 1000);
          var min = Math.floor(totalSec / 60);
          var sec = totalSec % 60;
          return min + " min " + sec + " sec";
        }
        function formatBytes(bytes) {
          if (bytes < 1024) return bytes + " Bytes";
          else if (bytes < 1048576)
            return (bytes / 1024).toFixed(1) + " KB";
          else if (bytes < 1073741824)
            return (bytes / 1048576).toFixed(1) + " MB";
          else return (bytes / 1073741824).toFixed(1) + " GB";
        }
        var meta = {
          duration: durationMs,
          durationReadable: formatDuration(durationMs),
          size: blob.size,
          sizeReadable: formatBytes(blob.size),
          mimeType: blob.type,
        };

        var readerBinary = new FileReader();
        readerBinary.onload = function (eBinary) {
          var binary = eBinary.target.result;
          var readerDataURL = new FileReader();
          readerDataURL.onload = function (eDataURL) {
            var audioBase64 = eDataURL.target.result;
            VoiceChatLib.analyzeAudio(blob)
              .then(function (analysis) {
                if (typeof self.onEnd === "function") {
                  self.onEnd({
                    event: "end",
                    timestamp: Date.now(),
                    details: "VoiceChat session ended",
                    audioBlob: blob,
                    audioMeta: meta,
                    audioBinary: binary,
                    audioBase64: audioBase64,
                    fileName: fileName,
                    analysis: analysis
                  });
                }
              })
              .catch(function (err) {
                console.error("Error analyzing audio:", err);
                if (typeof self.onEnd === "function") {
                  self.onEnd({
                    event: "end",
                    timestamp: Date.now(),
                    details: "VoiceChat session ended (audio analysis failed)",
                    audioBlob: blob,
                    audioMeta: meta,
                    audioBinary: binary,
                    audioBase64: audioBase64,
                    fileName: fileName,
                    analysis: { error: err }
                  });
                }
              });
          };
          readerDataURL.readAsDataURL(blob);
        };
        readerBinary.readAsArrayBuffer(blob);
      };
      this.mediaRecorder.stop();
    } else {
      if (typeof self.onEnd === "function") {
        self.onEnd({
          event: "end",
          timestamp: Date.now(),
          details: "VoiceChat session ended (no audio recorded)",
        });
      }
    }
  };

  // Reset and re-initialize internal state.
  VoiceChat.prototype.reset = function () {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.audioStream) {
      this.audioStream.getTracks().forEach(function (track) {
        track.stop();
      });
      this.audioStream = null;
    }
    if (this.audioContext) {
      if (this.audioContext.state !== "closed") {
        this.audioContext.close().catch(function (e) {
          console.warn(
            "AudioContext close failed (it may be already closed):",
            e
          );
        });
      }
      this.audioContext = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      try {
        this.mediaRecorder.stop();
      } catch (e) {
        console.error("Error stopping media recorder during reset:", e);
      }
      this.mediaRecorder = null;
    }
    this.recordedChunks = [];
    this.startTime = null;
    this.lastFrameTime = null;
    this.audioStarted = false;
    this.isMicOn = true;

    if (this.toggleBtn) this.toggleBtn.disabled = false;
    if (this.endBtn) this.endBtn.disabled = false;

    if (this.toggleBtn && this.toggleBtnBound) {
      this.toggleBtn.removeEventListener("click", this.handleToggle);
      this.toggleBtnBound = false;
    }
    if (this.endBtn && this.endBtnBound) {
      this.endBtn.removeEventListener("click", this.handleEnd);
      this.endBtnBound = false;
    }

    this.toggleBtn = null;
    this.endBtn = null;
    this.voiceEls = [];
    this.elementsBound = false;
  };

  // Start the library.
  VoiceChat.prototype.start = function () {
    this.observeDOM();
    this.initElements();
    if (!this.audioStarted) {
      this.initAudio();
    }
  };

  return {
    getInstance: function (options) {
      if (!instance) {
        instance = new VoiceChat(options || {});
      } else {
        if (options) instance.setOptions(options);
      }
      return instance;
    },
  };
})();

// Analyze recorded audio to detect if it's mostly silence/white noise.
VoiceChatLib.analyzeAudio = function (blob) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var arrayBuffer = e.target.result;
      var AudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      var offlineContext;
      try {
        offlineContext = new AudioContext(1, arrayBuffer.byteLength, 44100);
      } catch (err) {
        return reject(err);
      }
      offlineContext.decodeAudioData(
        arrayBuffer,
        function (audioBuffer) {
          var channelData = audioBuffer.getChannelData(0);
          var sum = 0;
          for (var i = 0; i < channelData.length; i++) {
            sum += Math.abs(channelData[i]);
          }
          var avgAmplitude = sum / channelData.length;
          // Define threshold for silence (adjust as needed).
          var isMostlySilence = avgAmplitude < 0.02;
          resolve({ isMostlySilence: isMostlySilence, avgAmplitude: avgAmplitude });
        },
        function (err) {
          reject(err);
        }
      );
    };
    reader.onerror = function (err) {
      reject(err);
    };
    reader.readAsArrayBuffer(blob);
  });
};
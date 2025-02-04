/* 
  VoiceChatLib is a self-contained JS library implemented as a singleton.
  Instead of hardcoding the required DOM elements, you pass them in via an
  "elements" option when creating the instance. The library supports dynamic
  binding via MutationObserver so that if elements are added later (via AJAX),
  they are immediately initialized with computed values to avoid abrupt changes.
  
  Public methods:
    • start()      – Binds elements (using provided options) and starts audio + recording.
    • toggleMic()  – Toggles the microphone on/off (pausing/resuming recording to omit silence).
    • end()        – Ends the session and passes the recorded audio (plus meta information) to the callback.
    • setOptions() – Updates configuration options.
    • reset()      – Resets and re-initializes internal state so new sessions can be started.
*/

var VoiceChatLib = (function() {
    var instance; // Singleton instance.
    
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
        baseRotationDivisor: 16,       // Divisor for base rotation speed (lower = faster)
        dynamicLerpMin: 0.05,          // Minimum lerp factor when quiet
        dynamicLerpAudioMultiplier: 0.5, // Additional lerp boost per audio level
        maxAdditionalRotation: 360,    // Maximum extra rotation (degrees) when audio is strong
        baseScaleMultiplier: 2.0,      // Factor controlling how much scale increases with audio
        // Elements can be passed in as selectors or DOM elements.
        elements: {
          toggleBtn: "#toggleMicBtn",
          endBtn: "#endChatBtn",
          micStatus: "#micStatus",
          micDevice: "#micDevice",
          voiceEls: ".a-cue-voice-el"
        }
      };
      if (options) {
        // Merge options (for both config and elements).
        for (var key in options) {
          if (options.hasOwnProperty(key)) {
            // If key is "elements", merge its properties.
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
      this.startTime = null;      // Reference for effective elapsed time.
      this.lastFrameTime = null;  // Last processed frame time.
      this.MAX_DELTA = 100;       // Maximum acceptable frame delta (ms). If exceeded, reset startTime.
      
      // DOM element references (initially null – bound in initElements).
      this.voiceEls = [];
      this.toggleBtn = null;
      this.endBtn = null;
      this.micStatus = null;
      this.micDevice = null;
      
      // Flags.
      this.elementsBound = false;
      this.audioStarted = false;
      this.domObserver = null;
      
      // New properties for recording.
      this.mediaRecorder = null;
      this.recordedChunks = [];
      
      // --- New event callback properties ---
      // Users can assign functions to these properties to be notified when an action occurs.
      this.onStart = null;   // Fired when audio (and recording) has been successfully started.
      this.onToggle = null;  // Fired when the microphone is toggled.
      this.onEnd = null;     // Fired when the session is ended (includes audio blob and meta info if available).
    }
    
    // Update configuration options.
    VoiceChat.prototype.setOptions = function(options) {
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
    
    // Bind the UI elements. If new visualizer elements are added later and audio is running,
    // initialize them immediately with computed target values.
    VoiceChat.prototype.initElements = function() {
      var elConfig = this.config.elements;
      // Use the helper to obtain elements (if passed as selectors, they’re looked up).
      this.toggleBtn = getElement(elConfig.toggleBtn, "#toggleMicBtn");
      this.endBtn = getElement(elConfig.endBtn, "#endChatBtn");
      this.micStatus = getElement(elConfig.micStatus, "#micStatus");
      this.micDevice = getElement(elConfig.micDevice, "#micDevice");
      this.voiceEls = getElementList(elConfig.voiceEls, ".a-cue-voice-el");
      
      var now = performance.now();
      for (var i = 0; i < this.voiceEls.length; i++) {
        var el = this.voiceEls[i];
        if (!el.initialized) {
          // Assign random parameters.
          var offset = (Math.random() * 360).toFixed(0);
          var speed = (1 + Math.random() * 2).toFixed(2);
          var scaleMultiplier = (1 + Math.random() * 1.5).toFixed(2);
          el.dataset.offset = offset;
          el.dataset.speed = speed;
          el.dataset.scaleMultiplier = scaleMultiplier;
          var originX = (45 + Math.random() * 10).toFixed(0);
          var originY = (45 + Math.random() * 10).toFixed(0);
          el.style.transformOrigin = originX + "% " + originY + "%";
          // If audio is running, set initial values to avoid sudden “catch-up”
          if (this.audioStarted && typeof this.startTime === "number") {
            var effectiveTime = now - this.startTime;
            var baseRot = parseFloat(offset) + ((effectiveTime * parseFloat(speed)) / this.config.baseRotationDivisor);
            var addRot = this.smoothedAmplitude * this.config.maxAdditionalRotation;
            el.currentRotation = baseRot + addRot;
            var tarScale = 1 + (this.smoothedAmplitude * parseFloat(scaleMultiplier) * this.config.baseScaleMultiplier);
            el.currentScale = tarScale;
          } else {
            el.currentRotation = 0;
            el.currentScale = 1;
          }
          el.initialized = true;
        }
      }
      
      // Bind event listeners to control buttons (if not already bound).
      var self = this;
      if (this.toggleBtn && !this.toggleBtnBound) {
        this.toggleBtn.addEventListener("click", function() {
          self.toggleMic();
        });
        this.toggleBtnBound = true;
      }
      if (this.endBtn && !this.endBtnBound) {
        this.endBtn.addEventListener("click", function() {
          self.end();
        });
        this.endBtnBound = true;
      }
      this.updateMicDisplay();
      this.elementsBound = true;
    };
    
    // Use a MutationObserver to rebind elements when the DOM changes (for dynamic content).
    VoiceChat.prototype.observeDOM = function() {
      var self = this;
      if (!this.domObserver) {
        this.domObserver = new MutationObserver(function(mutationsList) {
          self.initElements();
        });
        this.domObserver.observe(document.body, { childList: true, subtree: true });
      }
    };
    
    // Update the mic status display.
    VoiceChat.prototype.updateMicDisplay = function() {
      var statusText = this.isMicOn ? "Turn off microphone" : "Turn on microphone";
    
      if (this.toggleBtn) {
        this.toggleBtn.classList.toggle("is--on", this.isMicOn);
        this.toggleBtn.classList.toggle("is--off", !this.isMicOn);
      }
    
      if (this.micStatus) {
        this.micStatus.textContent = statusText;
      }
    };
    
    // Linear interpolation.
    VoiceChat.prototype.lerp = function(start, end, factor) {
      return start + factor * (end - start);
    };
    
    // Initialize audio capture and immediately start recording.
    VoiceChat.prototype.initAudio = function() {
      var self = this;
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(function(stream) {
          self.audioStream = stream;
          self.audioContext = new (window.AudioContext || window.webkitAudioContext)();
          self.microphone = self.audioContext.createMediaStreamSource(stream);
          self.analyser = self.audioContext.createAnalyser();
          self.analyser.fftSize = 256;
          self.microphone.connect(self.analyser);
          var track = self.audioStream.getAudioTracks()[0];
          if (track && track.label) {
            if (self.micDevice) {
              self.micDevice.textContent = "Communications - " + track.label;
            } else {
              var devElem = document.getElementById("micDevice");
              if (devElem) devElem.textContent = "Communications - " + track.label;
            }
          } else {
            if (self.micDevice) {
              self.micDevice.textContent = "Communications - Microphone (unknown)";
            }
          }
          self.updateMicDisplay();
    
          // Set initial time markers.
          self.startTime = performance.now();
          self.lastFrameTime = self.startTime;
    
          self.updateAnimation();
          self.audioStarted = true;
    
          // --- Start recording via MediaRecorder if available ---
          if (window.MediaRecorder) {
            self.recordedChunks = [];
            try {
              self.mediaRecorder = new MediaRecorder(self.audioStream);
              self.mediaRecorder.ondataavailable = function(e) {
                if (e.data && e.data.size > 0) {
                  self.recordedChunks.push(e.data);
                }
              };
              // Start recording immediately. (By default, this will record continuously.)
              self.mediaRecorder.start();
            } catch(err) {
              console.error("MediaRecorder creation failed:", err);
            }
          } else {
            console.warn("MediaRecorder API not supported in this browser.");
          }
    
          // --- Fire onStart event callback if defined ---
          if (typeof self.onStart === "function") {
            self.onStart({
              event: "start",
              timestamp: Date.now(),
              details: "VoiceChat audio and recording successfully started"
            });
          }
        })
        .catch(function(err) {
          console.error("Error accessing the microphone:", err);
          alert("Could not access the microphone. Check your permissions.");
        });
    };
    
    // Main animation loop.
    VoiceChat.prototype.updateAnimation = function() {
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
      self.smoothedAmplitude = self.smoothedAmplitude * (1 - self.config.amplitudeSmoothFactorVar) +
        (amplitudeNormalized * self.config.amplitudeSmoothFactorVar);
    
      var effectiveTime = now - self.startTime;
      var dynamicLerpFactor = self.config.dynamicLerpMin + (self.smoothedAmplitude * self.config.dynamicLerpAudioMultiplier);
    
      self.voiceEls.forEach(function(el) {
        var offset = parseFloat(el.dataset.offset);
        var speed = parseFloat(el.dataset.speed);
        var scaleMultiplier = parseFloat(el.dataset.scaleMultiplier);
        var baseRotation = offset + ((effectiveTime * speed) / self.config.baseRotationDivisor);
        var additionalRotation = self.smoothedAmplitude * self.config.maxAdditionalRotation;
        var targetRotation = baseRotation + additionalRotation;
        var targetScale = 1 + (self.smoothedAmplitude * scaleMultiplier * self.config.baseScaleMultiplier);
        el.currentRotation = self.lerp(el.currentRotation, targetRotation, dynamicLerpFactor);
        el.currentScale = self.lerp(el.currentScale, targetScale, dynamicLerpFactor);
        el.style.transform = "rotate(" + el.currentRotation.toFixed(2) + "deg) scale(" + el.currentScale.toFixed(2) + ")";
      });
    
      self.animationId = requestAnimationFrame(function() {
        self.updateAnimation();
      });
    };
    
    // Toggle microphone on/off. If MediaRecorder is used, pause/resume recording to omit silence.
    VoiceChat.prototype.toggleMic = function() {
      var self = this;
      if (this.mediaRecorder) {
        // If recording is active, pause it so that no audio is recorded.
        if (this.isMicOn) {
          if (this.mediaRecorder.state === "recording") {
            this.mediaRecorder.pause();
          }
          this.isMicOn = false;
          // Optionally, disable the audio tracks so that the analyser returns silence.
          if (this.audioStream) {
            this.audioStream.getAudioTracks().forEach(function(track) {
              track.enabled = false;
            });
          }
        } else {
          if (this.mediaRecorder.state === "paused") {
            this.mediaRecorder.resume();
          }
          this.isMicOn = true;
          if (this.audioStream) {
            this.audioStream.getAudioTracks().forEach(function(track) {
              track.enabled = true;
            });
          }
        }
      } else {
        // Fallback if MediaRecorder is not available.
        if (this.audioStream && this.audioStream.getAudioTracks().length > 0) {
          this.isMicOn = !this.isMicOn;
          this.audioStream.getAudioTracks().forEach(function(track) {
            track.enabled = self.isMicOn;
          });
        }
      }
      this.updateMicDisplay();
    
      // --- Fire onToggle callback ---
      if (typeof self.onToggle === "function") {
        self.onToggle({
          event: "toggleMic",
          timestamp: Date.now(),
          isMicOn: self.isMicOn,
          details: "Microphone toggled"
        });
      }
    };
    
    // End the session. Stops animations, stops audio and media recording,
    // combines the recorded audio into a Blob with meta information, and passes this to the callback.
    VoiceChat.prototype.end = function() {
      if (this.animationId) cancelAnimationFrame(this.animationId);
      var self = this;
      
      // Stop audio stream tracks.
      if (this.audioStream) {
        this.audioStream.getTracks().forEach(function(track) {
          track.stop();
        });
      }
      // Close audio context.
      if (this.audioContext) this.audioContext.close();
      if (this.toggleBtn) this.toggleBtn.disabled = true;
      if (this.endBtn) this.endBtn.disabled = true;
      if (this.micStatus) this.micStatus.textContent = "Voice Chat Ended";
      if (this.micDevice) this.micDevice.textContent = "";
      
      // If MediaRecorder is being used, stop it and wait for the onstop event.
      if (this.mediaRecorder && (this.mediaRecorder.state === "recording" || this.mediaRecorder.state === "paused")) {
        this.mediaRecorder.onstop = function(e) {
          // Combine the recorded chunks into a single Blob.
          var blob = new Blob(self.recordedChunks, { type: "audio/webm" });
          // Use the difference from startTime as the session duration.
          var duration = performance.now() - self.startTime; // milliseconds
          var meta = {
            duration: duration,  // you may convert to seconds if preferred
            size: blob.size,
            mimeType: blob.type
          };
          // --- Fire onEnd callback with audio data and meta information ---
          if (typeof self.onEnd === "function") {
            self.onEnd({
              event: "end",
              timestamp: Date.now(),
              details: "VoiceChat session ended",
              audioBlob: blob,
              audioMeta: meta
            });
          }
        };
        this.mediaRecorder.stop();
      } else {
        if (typeof self.onEnd === "function") {
          self.onEnd({
            event: "end",
            timestamp: Date.now(),
            details: "VoiceChat session ended (no audio recorded)"
          });
        }
      }
    };
    
    // Reset and re-initialize everything so that a new session can be started.
    VoiceChat.prototype.reset = function() {
      // Stop any ongoing animations.
      if (this.animationId) {
        cancelAnimationFrame(this.animationId);
        this.animationId = null;
      }
      // Stop and release the audio stream.
      if (this.audioStream) {
        this.audioStream.getTracks().forEach(function(track) {
          track.stop();
        });
        this.audioStream = null;
      }
      if (this.audioContext) {
        this.audioContext.close();
        this.audioContext = null;
      }
      // Stop the MediaRecorder if it exists.
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        try {
          this.mediaRecorder.stop();
        } catch (e) {
          console.error("Error stopping media recorder during reset:", e);
        }
        this.mediaRecorder = null;
      }
      // Reset recorded data.
      this.recordedChunks = [];
      // Reset timing and flags.
      this.startTime = null;
      this.lastFrameTime = null;
      this.audioStarted = false;
      this.isMicOn = true;
      
      // Re-enable UI control elements.
      if (this.toggleBtn) {
        this.toggleBtn.disabled = false;
      }
      if (this.endBtn) {
        this.endBtn.disabled = false;
      }
      if (this.micStatus) {
        this.micStatus.textContent = "Turn off microphone";
      }
      if (this.micDevice) {
        this.micDevice.textContent = "";
      }
      // (Optionally, reinitialize element-specific data if needed.)
    };
    
    // Start the library: bind elements (via MutationObserver so that if elements are inserted later, they get bound)
    // and initialize audio (and recording) if not already started.
    VoiceChat.prototype.start = function() {
      this.observeDOM();
      this.initElements();
      if (!this.audioStarted) {
        this.initAudio();
      }
    };
    
    return {
      getInstance: function(options) {
        if (!instance) {
          instance = new VoiceChat(options || {});
        } else {
          if (options) instance.setOptions(options);
        }
        return instance;
      }
    };
  })();
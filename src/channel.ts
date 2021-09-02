import { clip, getNote, getDuration } from './browser-clip';

/**
 * Get the next logical position to play in the session
 * Tone has a build-in method `Tone.Transport.nextSubdivision('4n')`
 * but I think it s better to round off as follows for live performance
 */
const getNextPos = (): number | string => {
  const arr = Tone.Transport.position.split(':');
  // If we are still around 0:0:0x, then set start position to 0
  if (arr[0] === '0' && arr[1] === '0') {
    return 0;
  }
  // Else set it to the next bar
  return +arr[0] + 1 + ':0:0';
};

/**
 * Channel
 * A channel is made up of a Tone.js Player/Instrument, one or more
 * Tone.js sequences (known as clips in Scribbletune)
 * & optionally a set of effects (with or without presets)
 *
 * API:
 * clips -> Get all clips for this channel
 * addClip -> Add a new clip to the channel
 * startClip -> Start a clip at the provided index
 * stopClip -> Stop a clip at the provided index
 * activeClipIdx -> Get the clip that is currently playing
 */
export class Channel {
  idx: number | string;
  name: string;
  activePatternIdx: number;
  channelClips: any;
  // player: any;
  instrument: any;
  // sampler: any;
  external: any;
  initializerTask: Promise<void>;
  hasLoaded: boolean; // if (!this.hasLoaded) - don't play this channel. Either still loading, or (initOutputProducer() rejected,
  hasFailed: boolean | Error;
  private eventCbFn: EventFn | undefined;

  constructor(params: ChannelParams) {
    this.idx = params.idx || 0;
    this.name = params.name || 'ch ' + params.idx;
    this.activePatternIdx = -1;
    this.channelClips = [];

    // Filter out unrequired params and create clip params object
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { clips, samples, sample, synth, ...params1 } = params;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { external, sampler, buffer, ...params2 } = params1;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { player, instrument, volume, ...params3 } = params2;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { eventCb, effects, ...params4 } = params3;
    const { context = Tone.getContext(), ...originalParamsFiltered } = params4;

    this.eventCbFn = eventCb;

    // Async section
    this.hasLoaded = false;
    this.hasFailed = false;
    this.initializerTask = this.initOutputProducer(context, params).then(() => {
      return this.initInstrument(context, params).then(() => {
        return this.adjustInstrument(context, params).then(() => {
          return this.initEffects(context, params);
        });
      });
    });
    // End Async section

    // Sync section
    let clipsFailed = false;
    try {
      params.clips.forEach((c: any, i: number) => {
        try {
          this.addClip({
            ...c,
            ...originalParamsFiltered,
          });
        } catch (e) {
          // Annotate the error with Clip info
          throw new Error(`${e.message} in clip ${i + 1}`);
        }
      }, this);
    } catch (e) {
      clipsFailed = e; // Stash the error
    }
    // End Sync section

    // Reconcile sync section with async section
    this.initializerTask
      .then(() => {
        if (clipsFailed) {
          throw clipsFailed;
        }
        this.hasLoaded = true;
        this.eventCb('loaded', {
          channel: this,
        }); // Report async load completion.
      })
      .catch(e => {
        this.hasFailed = e;
        console.error(
          `${e.message} in channel ${this.idx} "${this.name ?? '(no name)'}"`
        );
        this.eventCb('error', {
          e,
          channel: this,
        }); // Report async errors.
      });
  }

  static startTransport(): void {
    Tone.start();
    Tone.Transport.start();
  }

  static stopTransport(deleteEvents = true): void {
    Tone.Transport.stop();
    if (deleteEvents) {
      // Delete all events in the Tone.Transport
      Tone.Transport.cancel();
    }
  }

  setVolume(volume: number): void {
    // ? this.volume = volume;

    // Change volume of the player
    // if (this.player) {
    //   this.player.volume.value = volume;
    // }

    // Change volume of the sampler
    // if (this.sampler) {
    //   this.sampler.volume.value = volume;
    // }

    // Change volume of the instrument
    if (this.instrument) {
      this.instrument.volume.value = volume;
    }

    // Change volume of the external
    if (this.external) {
      this.external.setVolume?.(volume);
    }
  }

  startClip(idx: number, position?: number | string): void {
    position = position || (position === 0 ? 0 : getNextPos());
    // Stop any other currently running clip
    if (this.activePatternIdx > -1 && this.activePatternIdx !== idx) {
      this.stopClip(this.activePatternIdx, position);
    }

    if (this.channelClips[idx] && this.channelClips[idx].state !== 'started') {
      this.activePatternIdx = idx;
      this.channelClips[idx].start(position);
    }
  }

  stopClip(idx: number, position?: number | string): void {
    position = position || (position === 0 ? 0 : getNextPos());
    this.channelClips[idx].stop(position);
    if (idx === this.activePatternIdx) {
      this.activePatternIdx = -1;
    }
  }

  addClip(clipParams: ClipParams, idx?: number): void {
    idx = idx || this.channelClips.length;
    if (clipParams.pattern) {
      this.channelClips[idx as number] = clip(
        {
          ...clipParams,
        },
        this
      );
    } else {
      // Allow creation of empty clips
      this.channelClips[idx as number] = null;
    }
  }

  /**
   * @param  {Object} ClipParams clip parameters
   * @return {Function} function that can be used as the callback in Tone.Sequence https://tonejs.github.io/docs/Sequence
   */
  getSeqFn(params: ClipParams): SeqFn {
    let counter = 0;
    if (this.external) {
      return (time: string, el: string) => {
        if (this.hasLoaded && (el === 'x' || el === 'R')) {
          const duration = Tone.Time(getDuration(params, counter)).toSeconds();
          this.external.triggerAttackRelease?.(
            getNote(el, params, counter)[0],
            duration,
            time
          );
          counter++;
        }
      };
    } else if (this.instrument instanceof Tone.Player) {
      return (time: string, el: string) => {
        if (this.hasLoaded && (el === 'x' || el === 'R')) {
          this.instrument.start(time);
          counter++;
        }
      };
    } else if (
      this.instrument instanceof Tone.PolySynth ||
      this.instrument instanceof Tone.Sampler
    ) {
      return (time: string, el: string) => {
        if (this.hasLoaded && (el === 'x' || el === 'R')) {
          this.instrument.triggerAttackRelease(
            getNote(el, params, counter),
            getDuration(params, counter),
            time
          );
          counter++;
        }
      };
    } else if (this.instrument instanceof Tone.NoiseSynth) {
      return (time: string, el: string) => {
        if (this.hasLoaded && (el === 'x' || el === 'R')) {
          this.instrument.triggerAttackRelease(
            getDuration(params, counter),
            time
          );
          counter++;
        }
      };
    } else {
      return (time: string, el: string) => {
        if (this.hasLoaded && (el === 'x' || el === 'R')) {
          this.instrument.triggerAttackRelease(
            getNote(el, params, counter)[0],
            getDuration(params, counter),
            time
          );
          counter++;
        }
      };
    }
  }

  private eventCb(event: string, params: any): void {
    if (typeof this.eventCbFn === 'function') {
      this.eventCbFn(event, params);
    }
  }

  /**
   * Check Tone.js object loaded state and either invoke `resolve` right away, or attach to and wait using Tone onload cb.
   * It's an ugly hack that reaches into Tone's internal ._buffers or ._buffer to insert itself into .onload() callback.
   * Tone has different ways to pull the onload callback from within to the API, so this implementation is very brittle.
   * The sole reason for its existence is to handle async loaded state of Tone instruments that we allow to pass in from outside.
   * If that option is eliminated, then this hacky function can be killed (or re-implemented via public onload API)
   * @param toneObject Tone.js object (will work with non-Tone objects that have same loaded/onload properties)
   * @param resolve onload callback
   */
  private checkToneObjLoaded(toneObject: any, resolve: () => void) {
    const skipRecursion = toneObject instanceof Tone.Sampler; // Sampler has a Map of ToneAudioBuffer, and our method to find inner .onload() does not work since there is no single one.

    // eslint-disable-next-line no-prototype-builtins
    if ('loaded' in toneObject) {
      if (toneObject.loaded) {
        resolve();
        return;
      }
      if (skipRecursion) {
        return;
      }
      // Try Recursion into inner objects:
      let handled = false;
      ['buffer', '_buffer', '_buffers'].forEach(key => {
        if (key in toneObject) {
          this.checkToneObjLoaded(toneObject[key], resolve);
          handled = true;
        }
      });
      if (handled) {
        return;
      }
    }

    // Check object type if it has load/onload (and _buffers or _buffer), then call resolve()
    // The list was created for Tone@14.8.0 by grepping and reviewing the source code.
    // Known objecs to have:
    const hasOnload =
      toneObject instanceof Tone.ToneAudioBuffer ||
      toneObject instanceof Tone.ToneBufferSource ||
      // Falback for "future" objects
      ('loaded' in toneObject && 'onload' in toneObject);

    if (!hasOnload) {
      // console.log('resolve() for ch "%o" idx %o onload NOT FOUND', this.name, this.idx);
      // This is not a good assumption. E.g. it does not work for Tone.ToneAudioBuffers
      resolve();
    } else {
      const oldOnLoad = toneObject.onload;
      toneObject.onload = () => {
        if (oldOnLoad && typeof oldOnLoad === 'function') {
          toneObject.onload = oldOnLoad;
          oldOnLoad();
        }
        // console.log('resolve() for ch "%o" idx %o', this.name, this.idx);
        resolve();
      };
    }
  }

  private recreateToneObjectInContext(
    toneObject: any, // Tone.PolySynth | Tone.Player | Tone.Sampler | Tone['' | '']
    context: any
  ): Promise<any> {
    context = context || Tone.getContext();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return new Promise<any>((resolve, reject) => {
      // Tone.PolySynth | Tone.Player | Tone.Sampler | Tone['' | '']
      if (toneObject instanceof Tone.PolySynth) {
        const newObj = Tone.PolySynth(Tone[toneObject._dummyVoice.name], {
          ...toneObject.get(),
          context,
        });
        this.checkToneObjLoaded(newObj, () => resolve(newObj));
      } else if (toneObject instanceof Tone.Player) {
        const newObj = Tone.Player({
          url: toneObject._buffer,
          context,
          onload: () => this.checkToneObjLoaded(newObj, () => resolve(newObj)),
        });
      } else if (toneObject instanceof Tone.Sampler) {
        const { attack, curve, release, volume } = toneObject.get();
        const paramsFromSampler = {
          attack,
          curve,
          release,
          volume,
        };
        const paramsFromBuffers = {
          baseUrl: toneObject._buffers.baseUrl,
          urls: Object.fromEntries(toneObject._buffers._buffers.entries()),
        };
        const newObj = Tone.Sampler({
          ...paramsFromSampler,
          ...paramsFromBuffers,
          context,
          onload: () => this.checkToneObjLoaded(newObj, () => resolve(newObj)),
        });
      } else {
        const newObj = Tone[toneObject.name]({
          ...toneObject.get(),
          context,
          onload: () => this.checkToneObjLoaded(newObj, () => resolve(newObj)),
        });
        this.checkToneObjLoaded(newObj, () => resolve(newObj));
      }
    });
  }

  private initOutputProducer(
    context: any,
    params: ChannelParams
  ): Promise<void> {
    context = context || Tone.getContext();
    return new Promise<void>((resolve, reject) => {
      /*
       *  1. The params object can be used to pass a sample (sound source) OR a synth(Synth/FMSynth/AMSynth etc) or samples.
       *  Scribbletune will then create a Tone.js Player or Tone.js Instrument or Tone.js Sampler respectively
       *  2. It can also be used to pass a Tone.js Player object or instrument that was created elsewhere
       *  (mostly by Scribbletune itself in the channel creation method)
       **/

      if (params.synth) {
        if (params.instrument) {
          throw new Error(
            'Either synth or instrument can be provided, but not both.'
          );
        }
        if ((params.synth as SynthParams).synth) {
          const synthName = (params.synth as SynthParams).synth;
          //  const presetName = (params.synth as SynthParams).presetName; // Unused here
          const preset = (params.synth as SynthParams).preset || {};
          this.instrument = new Tone[synthName]({
            ...preset,
            context,
            // Use onload for cases when synthName calls out Tone.Sample/Player/Sampler.
            // It could be a universal way to load Tone.js instruments.
            onload: () => this.checkToneObjLoaded(this.instrument, resolve),
            // This onload is ignored in all synths. Therefore we call checkToneObjLoaded() again below.
            // It is safe to call resolve() multiple times for Promise<void>
          });
          this.checkToneObjLoaded(this.instrument, resolve);
        } else {
          this.instrument = params.synth; // TODO: This is dangerous by-reference assignment.
          console.warn(
            'The "synth" parameter with instrument will be deprecated in the future. Please use the "instrument" parameter instead.'
          );
          // params.synth describing the Tone[params.synth.synth] is allowed.
          this.checkToneObjLoaded(this.instrument, resolve);
        }
      } else if (typeof params.instrument === 'string') {
        this.instrument = new Tone[params.instrument]({ context });
        this.checkToneObjLoaded(this.instrument, resolve);
      } else if (params.instrument) {
        this.instrument = params.instrument; // TODO: This is dangerous by-reference assignment. Tone.instrument has context that holds all other instruments. Client side params get polluted with circular references. If params come from e.g. react-ApolloClient data, Apollo tools crash on circular references.
        this.checkToneObjLoaded(this.instrument, resolve);
      } else if (params.sample || params.buffer) {
        this.instrument = new Tone.Player({
          url: params.sample || params.buffer,
          context,
          onload: () => this.checkToneObjLoaded(this.instrument, resolve),
        });
      } else if (params.samples) {
        this.instrument = new Tone.Sampler({
          urls: params.samples,
          context,
          onload: () => this.checkToneObjLoaded(this.instrument, resolve),
        });
      } else if (params.sampler) {
        this.instrument = params.sampler; // TODO: This is dangerous by-reference assignment.
        this.checkToneObjLoaded(this.instrument, resolve);
      } else if (params.player) {
        this.instrument = params.player; // TODO: This is dangerous by-reference assignment.
        this.checkToneObjLoaded(this.instrument, resolve);
      } else if (params.external) {
        this.external = { ...params.external }; // Sanitize object by shallow clone
        this.instrument = {
          context,
          volume: { value: 0 },
        };
        // Do not call! this.checkToneObjLoaded(this.instrument, resolve);

        if (params.external.init) {
          return params.external
            .init(context.rawContext)
            .then(() => {
              console.log(
                `Loaded external output module for channel idx ${
                  this.idx
                } "${this.name ?? '(no name)'}"`
              );
              resolve();
            })
            .catch((e: any) => {
              reject(
                new Error(
                  `${e.message} loading external output module of channel idx ${
                    this.idx
                  }, ${this.name ?? '(no name)'}`
                )
              );
            });
        } else {
          resolve();
        }
      } else {
        throw new Error(
          'One of required synth|instrument|sample|sampler|samples|buffer|player|external is not provided!'
        );
      }

      if (!this.instrument) {
        throw new Error('Failed instantiating instrument from given params.');
      }
    });
  }

  private initInstrument(context: any, params: ChannelParams): Promise<void> {
    context = context || Tone.getContext();
    if (!params.external && this.instrument?.context !== context) {
      return this.recreateToneObjectInContext(this.instrument, context).then(
        newObj => {
          this.instrument = newObj;
        }
      );
    } else {
      // Nothing to do
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      return new Promise<void>((resolve, reject) => {
        resolve();
      });
    }
  }

  private adjustInstrument(context: any, params: ChannelParams): Promise<void> {
    context = context || Tone.getContext();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return new Promise<void>((resolve, reject) => {
      if (params.volume) {
        // this.instrument.volume.value = params.volume;
        this.setVolume(params.volume);
      }
      resolve();
    });
  }

  private initEffects(context: any, params: ChannelParams): Promise<void> {
    context = context || Tone.getContext();

    const createEffect = (effect: any): Promise<any> => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      return new Promise<any>((resolve, reject) => {
        if (typeof effect === 'string') {
          resolve(new Tone[effect]({ context }));
        } else if (effect.context !== context) {
          return this.recreateToneObjectInContext(effect, context);
        } else {
          resolve(effect);
        }
      }).then(effect => {
        return effect.toDestination();
      });
    };

    const startEffect = (eff: any) => {
      return typeof eff.start === 'function' ? eff.start() : eff;
    };

    const toArray = (someVal: any): any[] => {
      if (!someVal) {
        return [];
      }
      if (Array.isArray(someVal)) {
        return someVal;
      }
      return [someVal];
    };

    const effectsIn = toArray(params.effects);
    if (params.external) {
      if (effectsIn.length !== 0) {
        throw new Error('Effects cannot be used with external output');
      }
      return Promise.resolve();
    }

    // effects = params.effects.map(createEffect).map(startEffect);
    return Promise.all(effectsIn.map(createEffect))
      .then(results => results.map(startEffect))
      .then(effects => {
        this.instrument.chain(...effects).toDestination();
      });
  }

  get clips(): any[] {
    return this.channelClips;
  }

  get activeClipIdx(): number {
    return this.activePatternIdx;
  }
}

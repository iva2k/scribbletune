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
  activePatternIdx: number;
  channelClips: any;
  player: any;
  instrument: any;
  sampler: any;
  external: any;
  initializerTask: Promise<void>;

  constructor(params: ChannelParams) {
    (this.idx = params.idx || 0), (this.activePatternIdx = -1);
    this.channelClips = [];

    this.initializerTask = this.initOutputProducer(undefined, params).catch(
      e => {
        console.error(`${e.message} in channel ${this.idx} "${params?.name}"`);
        // TODO: Implement a mechanism to handle async errors.
      }
    );

    // Filter out unrequired params and create clip params object
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { clips, samples, sample, synth, ...params1 } = params;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { external, sampler, buffer, ...params2 } = params1;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { player, instrument, volume, ...originalParamsFiltered } = params2;

    params.clips.forEach((c: any, i: number) => {
      try {
        this.addClip({ ...c, ...originalParamsFiltered });
      } catch (e) {
        throw new Error(
          `${e.message} in channel ${this.idx} "${params?.name}" clip ${i + 1}`
        );
      }
    }, this);
  }

  static startTransport(): void {
    Tone.start();
    Tone.Transport.start();
  }

  static stopTransport(): void {
    Tone.Transport.stop();
  }

  setVolume(volume: number): void {
    // ? this.volume = volume;

    // Change volume of the player
    if (this.player) {
      this.player.volume.value = volume;
    }

    // Change volume of the sampler
    if (this.sampler) {
      this.sampler.volume.value = volume;
    }

    // Change volume of the instrument
    if (this.instrument) {
      this.instrument.volume.value = volume;
    }

    // Change volume of the external
    if (this.external) {
      this.external?.setVolume(volume);
    }
  }

  startClip(idx: number): void {
    // Stop any other currently running clip
    if (this.activePatternIdx > -1 && this.activePatternIdx !== idx) {
      this.stopClip(this.activePatternIdx);
    }

    if (this.channelClips[idx] && this.channelClips[idx].state !== 'started') {
      this.activePatternIdx = idx;
      this.channelClips[idx].start(getNextPos());
    }
  }

  stopClip(idx: number): void {
    this.channelClips[idx].stop(getNextPos());
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
        if (el === 'x' || el === 'R') {
          this.external?.triggerAttackRelease(
            getNote(el, params, counter)[0],
            getDuration(params, counter),
            time
          );
          counter++;
        }
      };
    } else if (this.instrument instanceof Tone.Player) {
      return (time: string, el: string) => {
        if (el === 'x' || el === 'R') {
          this.instrument.start(time);
          counter++;
        }
      };
    } else if (
      this.instrument instanceof Tone.PolySynth ||
      this.instrument instanceof Tone.Sampler
    ) {
      return (time: string, el: string) => {
        if (el === 'x' || el === 'R') {
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
        if (el === 'x' || el === 'R') {
          this.instrument.triggerAttackRelease(
            getDuration(params, counter),
            time
          );
          counter++;
        }
      };
    } else {
      return (time: string, el: string) => {
        if (el === 'x' || el === 'R') {
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

  private recreateToneObjectInContext(
    toneObject: any, // Tone.PolySynth | Tone.Player | Tone.Sampler | Tone['' | '']
    context: any
  ): any {
    // Tone.PolySynth | Tone.Player | Tone.Sampler | Tone['' | '']
    if (toneObject instanceof Tone.PolySynth) {
      return new Tone.PolySynth(Tone[toneObject._dummyVoice.name], {
        ...toneObject.get(),
        context,
      });
    } else if (toneObject instanceof Tone.Player) {
      return new Tone.Player({
        url: toneObject._buffer,
        context,
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
      return new Tone.Sampler({
        ...paramsFromSampler,
        ...paramsFromBuffers,
        context,
      });
    } else {
      return new Tone[toneObject.name]({
        ...toneObject.get(),
        context,
      });
    }
  }

  private async initOutputProducer(
    context: any,
    params: ChannelParams
  ): Promise<void> {
    context = context || Tone.getContext();
    return new Promise((resolve, reject) => {
      try {
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
          params.instrument = params.synth;
          console.warn(
            'The "synth" parameter will be deprecated in the future. Please use the "instrument" parameter instead.'
          );

          // this.instrument = new Tone[params.synth]();
        }

        if (typeof params.instrument === 'string') {
          this.instrument = new Tone[params.instrument]({ context });
        } else if (params.instrument) {
          this.instrument = params.instrument;
        } else if (params.sample || params.buffer) {
          this.instrument = new Tone.Player({
            url: params.sample || params.buffer,
            context,
          });
        } else if (params.samples) {
          this.instrument = new Tone.Sampler({
            urls: params.samples,
            context,
          });
        } else if (params.sampler) {
          this.instrument = params.sampler;
        } else if (params.player) {
          this.instrument = params.player;
        } else if (params.external) {
          this.external = params.external;
          this.instrument = {
            context,
            volume: { value: 0 },
          };
        } else {
          throw new Error(
            'One of required synth|instrument|sample|sampler|samples|buffer|player|external is not provided!'
          );
        }

        if (!this.instrument) {
          throw new Error('Failed instantiating instrument from given params.');
        }
      } catch (e) {
        reject(
          new Error(`${e.message} in channel ${this.idx} "${params?.name}"`)
        );
      }

      const createEffect = (eff: any) => {
        let effect: any;
        if (typeof eff === 'string') {
          effect = new Tone[eff]({
            context,
          });
        } else if (eff.context !== context) {
          effect = this.recreateToneObjectInContext(eff, context);
        } else {
          effect = eff;
        }
        return effect.toDestination();
      };

      const startEffect = (eff: any) => {
        return typeof eff.start === 'function' ? eff.start() : eff;
      };

      let effects = [];
      if (params.effects) {
        if (!Array.isArray(params.effects)) {
          params.effects = [params.effects];
        }
        effects = params.effects.map(createEffect).map(startEffect);
      }

      if (!params.external && this.instrument?.context !== context) {
        this.instrument = this.recreateToneObjectInContext(
          this.instrument,
          context
        );
      }

      if (params.volume) {
        this.instrument.volume.value = params.volume;
      }

      if (params.external) {
        if (effects.length !== 0) {
          throw new Error('Effects cannot be used with external output');
        }
      } else {
        this.instrument.chain(...effects).toDestination();
      }

      if (params.external && params.external.init) {
        return params.external
          .init(context.rawContext)
          .then(() => {
            console.log(
              'Loaded external output module for channel idx %s %s',
              params?.idx,
              params?.name
            );
            resolve();
          })
          .catch((e: any) => {
            reject(
              new Error(
                `${e.message} loading external output module of channel idx ${params?.idx}, ${params?.name}`
              )
            );
          });
      }

      resolve();
    });
  }

  get clips(): any[] {
    return this.channelClips;
  }

  get activeClipIdx(): number {
    return this.activePatternIdx;
  }
}

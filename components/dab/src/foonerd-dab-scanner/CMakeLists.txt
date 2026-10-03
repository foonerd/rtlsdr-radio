cmake_minimum_required( VERSION 3.5 )
set (objectName dab_scanner)
# Volumio optimization flags for professional audio quality
set (CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wall -std=c++11 -O3 -ffast-math -funroll-loops")
set (CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -Wall -O3 -ffast-math -funroll-loops")
set (CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} ")

# Link Time Optimization for Release builds
# NOTE: LTO disabled for ARMv6 due to GCC assembler bugs with older ARM
if (CMAKE_BUILD_TYPE STREQUAL "Release")
    if (NOT CMAKE_CXX_FLAGS MATCHES "-march=armv6")
        set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -flto")
        set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -flto")
        set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -flto")
    endif()
endif()
if (CMAKE_INSTALL_PREFIX_INITIALIZED_TO_DEFAULT)
    set (CMAKE_INSTALL_PREFIX "/usr/local/bin" CACHE PATH "default install path" FORCE )
endif()
#set (CMAKE_INSTALL_PREFIX /usr/local/bin)

if(MINGW)
    add_definitions ( -municode)
endif()

########################################################################
# select the release build type by default to get optimization flags
########################################################################
if(NOT CMAKE_BUILD_TYPE)
   set(CMAKE_BUILD_TYPE "Release")
   message(STATUS "Build type not specified: defaulting to release.")
endif(NOT CMAKE_BUILD_TYPE)
set(CMAKE_BUILD_TYPE ${CMAKE_BUILD_TYPE} CACHE STRING "")

### make sure our local CMake Modules path comes first
list(INSERT CMAKE_MODULE_PATH 0 ${CMAKE_SOURCE_DIR}/cmake/Modules)

######################################################################
#
########################################################################

OPTION(RTLSDR   "Input: RTLSDR"   OFF)
OPTION(SDRPLAY  "Input: SDRPLAY"  OFF)
OPTION(AIRSPY   "Input: AirSpy"   OFF)
OPTION(HACKRF	"Input: HACKRF"	  OFF)
OPTION(RTL_TCP	"Input: RTL_TCP"  OFF)
OPTION(LIMESDR	"Input: LIMESDR"  OFF)
OPTION(SDRPLAY_V3  "Input: SDRPlay_V3"  OFF)

OPTION(X64_DEFINED "optimize for x64/SSE"  OFF)
OPTION(RPI_DEFINED "optimize for ARM/NEON" OFF)

if ( (NOT RTLSDR) AND (NOT SDRPLAY) AND (NOT AirSpy) AND (NOT HACKRF) AND (NOT LIMESDR) AND (NOT SDRPLAY_V3) AND (NOT RTL_TCP) )
   message("None of the Input Options selected. Using default SDRPlay")
   set(SDRPlay ON)
endif ()

set (objectName "")

if(RTLSDR)
   if (objectName STREQUAL "")
      set(RTLSDR ON)
      set(objectName dab-scanner-rtlsdr)
   else ()
      message ("Ignoring second option")
   endif ()
endif ()

if(SDRPLAY)
   if (objectName STREQUAL "")
      set(SDRPLAY ON)
      set(objectName dab-scanner-sdrplay-v2)
   else ()
      message ("Ignoring second option")
   endif ()
endif ()

if(AIRSPY)
   if (objectName STREQUAL "")
      set(AIRSPY ON)
      set(objectName dab-scanner-airspy)
   else ()
      message ("Ignoring second option")
   endif ()
endif ()

if(RTL_TCP)
   if (objectName STREQUAL "")
      set(RTL_TCP ON)
      set(objectName dab-scanner-rtl_tcp)
   else ()
      message ("Ignoring second option")
   endif ()
endif ()

if(HACKRF)
   if (objectName STREQUAL "")
      set(HACKRF ON)
      set(objectName dab-scanner-hackrf)
   else ()
      message ("Ignoring second option")
   endif ()
endif ()

if(LIMESDR)
   if (objectName STREQUAL "")
      set(LIMESDR ON)
      set(objectName dab-scanner-lime)
   else ()
      message ("Ignoring second option")
   endif ()
endif ()

if(SDRPLAY_V3)
   if (objectName STREQUAL "")
      set(SDRPLAY_V3 ON)
      set(objectName dab-scanner-sdrplay-v3)
   else ()
      message ("Ignoring second option")
   endif ()
endif ()


#########################################################################
	find_package (PkgConfig)

        find_package(FFTW3f)
        if (NOT FFTW3F_FOUND)
            message(FATAL_ERROR "please install FFTW3")
        endif ()

        find_package(Faad)
        if (NOT FAAD_FOUND )
            message(FATAL_ERROR "please install libfaad")
        endif ()

        find_package(zlib)
	if (NOT ZLIB_FOUND)
            message(FATAL_ERROR "please install libz")
        endif ()
	list(APPEND extraLibs ${ZLIB_LIBRARY})

	find_package(LibSndFile)
        if (NOT LIBSNDFILE_FOUND)
            message(FATAL_ERROR "please install libsndfile")
        endif ()
        list(APPEND extraLibs ${LIBSNDFILE_LIBRARY})

	find_library (PTHREADS pthread)
	set(PTHREADS "pthread")
	if (NOT(PTHREADS))
	   message (FATAL_ERROR "please install libpthread")
	else (NOT(PTHREADS))
	   set (extraLibs ${extraLibs} ${PTHREADS})
	endif (NOT(PTHREADS))


#########################################################################
        find_package (PkgConfig)

##########################################################################
#	The devices
#

	if (RTL_TCP)
	   include_directories (
	     ../foonerd-dab/devices/rtl_tcp
	   )
	   set ($(objectName)_HDRS
	        ${${objectName}_HDRS}
	        ../foonerd-dab/devices/rtl_tcp/rtl_tcp-client.h
           )

	   set (${objectName}_SRCS
	        ${${objectName}_SRCS}
	        ../foonerd-dab/devices/rtl_tcp/rtl_tcp-client.cpp
	   )

	add_definitions (-DHAVE_RTL_TCP)
	endif (RTL_TCP)
	if (SDRPLAY)
	   find_path (SDRPLAYLIB_INCLUDE_DIR
                      NAMES mirsdrapi-rsp.h
                      PATHS
                      /usr/local/include/
	   )
           include_directories (${SDRPLAYLIB_INCLUDE_DIR})

           find_library (SDRPLAYLIB mirsdrapi-rsp)
           if(NOT(SDRPLAYLIB))
              message(FATAL_ERROR "please install -lmirsdrapi-rsp")
           else(NOT(SDRPLAYLIB))
              list (APPEND extraLibs ${SDRPLAYLIB})
           endif(NOT(SDRPLAYLIB))

	   include_directories (
	     ../foonerd-dab/devices/sdrplay-handler
	   )

	   set ($(objectName)_HDRS
	        ${${objectName}_HDRS}
	        ../foonerd-dab/devices/sdrplay-handler/sdrplay-handler.h
           )

	   set (${objectName}_SRCS
	        ${${objectName}_SRCS}
	        ../foonerd-dab/devices/sdrplay-handler/sdrplay-handler.cpp
	   )

	 add_definitions (-DHAVE_SDRPLAY)
	endif (SDRPLAY)

	if (SDRPLAY_V3)
	   find_path (SDRPLAYLIB_INCLUDE_DIR
                      NAMES sdrplay_api.h
                      PATHS
                      /usr/local/include/
	   )
           include_directories (${SDRPLAYLIB_INCLUDE_DIR})

           find_library (SDRPLAYLIB sdrplay_api)
           if(NOT(SDRPLAYLIB))
              message(FATAL_ERROR "please install -lsdrplay_api")
           else(NOT(SDRPLAYLIB))
              list (APPEND extraLibs ${SDRPLAYLIB})
           endif(NOT(SDRPLAYLIB))

	   include_directories (
	     ../foonerd-dab/devices/sdrplay-handler-v3
	   )

	   set ($(objectName)_HDRS
	        ${${objectName}_HDRS}
	        ../foonerd-dab/devices/sdrplay-handler-v3/sdrplay-handler-v3.h
           )

	   set (${objectName}_SRCS
	        ${${objectName}_SRCS}
	        ../foonerd-dab/devices/sdrplay-handler-v3/sdrplay-handler-v3.cpp
	   )

	   add_definitions (-DHAVE_SDRPLAY_V3)
	endif (SDRPLAY_V3)

	if (HACKRF)
	   find_path (HACKLIB_INCLUDE_DIR
                      NAMES mirsdrapi-rsp.h
                      PATHS
	              ../foonerd-dab/devices/hackrf-handler/libhackrf/
                       /usr/local/include/
	   )
           include_directories (${HACKLIB_INCLUDE_DIR})

           find_library (HACKLIB hackrf)
           if(NOT(HACKLIB))
              message(FATAL_ERROR "please install -lhackrf")
           else(NOT(HACKLIB))
              list (APPEND extraLibs ${HACKLIB})
           endif(NOT(HACKLIB))

	   include_directories (
	     ../foonerd-dab/devices/hackrf-handler
	   )

	   set ($(objectName)_HDRS
	        ${${objectName}_HDRS}
	        ../foonerd-dab/devices/hackrf-handler/hackrf-handler.h
           )

	   set (${objectName}_SRCS
	        ${${objectName}_SRCS}
	        ../foonerd-dab/devices/hackrf-handler/hackrf-handler.cpp
	   )

	 add_definitions (-DHAVE_HACKRF)
	endif (HACKRF)

	if (LIMESDR)
           find_library (LIMELIB LimeSuite)
           if(NOT(LIMELIB))
              message(FATAL_ERROR "please install LimeSuite")
           else(NOT(LIMELIB))
              list (APPEND extraLibs ${LIMELIB})
           endif(NOT(LIMELIB))

	   include_directories (
	     ../foonerd-dab/devices/lime-handler
	   )

	   set ($(objectName)_HDRS
	        ${${objectName}_HDRS}
	        ../foonerd-dab/devices/lime-handler/LMS7002M_parameters.h
	        ../foonerd-dab/devices/lime-handler/LimeSuite.h
	        ../foonerd-dab/devices/lime-handler/lime-handler.h
           )

	   set (${objectName}_SRCS
	        ${${objectName}_SRCS}
	        ../foonerd-dab/devices/lime-handler/lime-handler.cpp
	   )

	 add_definitions (-DHAVE_LIME)
	endif (LIMESDR)

	if (AIRSPY)
           find_package(LibAIRSPY)
           if (NOT LIBAIRSPY_FOUND)
               message(FATAL_ERROR "please install airspy library")
           endif ()
	   ### include_directories (${AIRSPYLIB_INCLUDE_DIR})

	   include_directories (
	     ../foonerd-dab/devices/airspy-handler
	   )

	   set ($(objectName)_HDRS
	        ${${objectName}_HDRS}
	        ../foonerd-dab/devices/airspy-handler/airspy-handler.h
	   )

	   set (${objectName}_SRCS
	        ${${objectName}_SRCS}
	        ../foonerd-dab/devices/airspy-handler/airspy-handler.cpp
	   )

	   add_definitions (-DHAVE_AIRSPY)
	endif (AIRSPY)


	if (RTLSDR)
           find_package(LibRTLSDR)
           if (NOT LIBRTLSDR_FOUND)
               message(FATAL_ERROR "please install librtlsdr")
           endif ()
	   ###include_directories (${RTLSDR_INCLUDE_DIR})

	   include_directories (
	        ../foonerd-dab/devices/rtlsdr-handler/
	   )

	   set (${objectName}_HDRS
	        ${${objectName}_HDRS}
	        ../foonerd-dab/devices/rtlsdr-handler/rtlsdr-handler.h
	   )

	   set (${objectName}_SRCS
	        ${${objectName}_SRCS}
	        ../foonerd-dab/devices/rtlsdr-handler/rtlsdr-handler.cpp
	   )

	   add_definitions (-DHAVE_RTLSDR)
	endif()


#######################################################################
#
#	Here we really start

	include_directories (
	           ${CMAKE_SOURCE_DIR} ${CMAKE_CURRENT_BINARY_DIR}
	           .
	           ./
	           ./tii-handling
	           ../foonerd-dab/
	           ../foonerd-dab/devices
	           ../foonerd-dab/library
	           ../foonerd-dab/library/includes
	           ../foonerd-dab/library/includes/ofdm
	           ../foonerd-dab/library/includes/backend
	           ../foonerd-dab/library/includes/backend/audio
	           ../foonerd-dab/library/includes/backend/data
	           ../foonerd-dab/library/includes/backend/data/mot
	           ../foonerd-dab/library/includes/backend/data/journaline
	           ../foonerd-dab/library/includes/support
	           ../foonerd-dab/library/includes/support/viterbi-spiral
	           /usr/include/
	)

	set (${objectName}_HDRS
	     ${${objectName}_HDRS}
	     ./ringbuffer.h
	     ./tii-handling/tii-handler.h
             ./tii-handling/tiiQueue.h
             ./tii-handling/tii-reader.h
             ./tii-handling/cacheElement.h
	     ./dab_tables.h
	     ./service-printer.h
	     ../dab-api.h
	     ../foonerd-dab/devices/device-handler.h
	     ../foonerd-dab/devices/device-exceptions.h
	     ../foonerd-dab/library/includes/dab-constants.h
	     ../foonerd-dab/library/includes/dab-processor.h
	     ../foonerd-dab/library/includes/bit-extractors.h
             ../foonerd-dab/library/includes/time-converter.h
	     ../foonerd-dab/library/includes/ofdm/phasereference.h
	     ../foonerd-dab/library/includes/ofdm/phasetable.h
	     ../foonerd-dab/library/includes/ofdm/freq-interleaver.h
	     ../foonerd-dab/library/includes/ofdm/timesyncer.h
	     ../foonerd-dab/library/includes/ofdm/fic-handler.h
	     ../foonerd-dab/library/includes/ofdm/fib-table.h
             ../foonerd-dab/library/includes/ofdm/ensemble.h
             ../foonerd-dab/library/includes/ofdm/fib-config.h
             ../foonerd-dab/library/includes/ofdm/fib-decoder.h
	     ../foonerd-dab/library/includes/ofdm/sample-reader.h
	     ../foonerd-dab/library/includes/ofdm/tii-detector.h
	     ../foonerd-dab/library/includes/backend/firecode-checker.h
	     ../foonerd-dab/library/includes/backend/backend-base.h
	     ../foonerd-dab/library/includes/backend/galois.h
	     ../foonerd-dab/library/includes/backend/reed-solomon.h
	     ../foonerd-dab/library/includes/backend/msc-handler.h
	     ../foonerd-dab/library/includes/backend/virtual-backend.h
	     ../foonerd-dab/library/includes/backend/audio-backend.h
	     ../foonerd-dab/library/includes/backend/data-backend.h
	     ../foonerd-dab/library/includes/backend/audio/faad-decoder.h
	     ../foonerd-dab/library/includes/backend/audio/mp4processor.h 
	     ../foonerd-dab/library/includes/backend/audio/mp2processor.h 
	     ../foonerd-dab/library/includes/backend/data/virtual-datahandler.h 
	     ../foonerd-dab/library/includes/backend/data/tdc-datahandler.h 
	     ../foonerd-dab/library/includes/backend/data/pad-handler.h 
	     ../foonerd-dab/library/includes/backend/data/data-processor.h
	     ../foonerd-dab/library/includes/backend/data/mot/mot-handler.h 
	     ../foonerd-dab/library/includes/backend/data/mot/mot-dir.h 
	     ../foonerd-dab/library/includes/backend/data/mot/mot-object.h
	     ../foonerd-dab/library/includes/support/band-handler.h 
	     ../foonerd-dab/library/includes/support/charsets.h
#	     ../library/includes/support/viterbi_handler.h
	     ../foonerd-dab/library/includes/support/protTables.h
	     ../foonerd-dab/library/includes/support/protection.h
	     ../foonerd-dab/library/includes/support/uep-protection.h
	     ../foonerd-dab/library/includes/support/eep-protection.h
	     ../foonerd-dab/library/includes/support/fft-handler.h
	     ../foonerd-dab/library/includes/support/dab-params.h
	     ../foonerd-dab/library/includes/support/tii_table.h
	     ../foonerd-dab/library/includes/support/viterbi-spiral/viterbi-spiral.h
	)

	set (${objectName}_SRCS
	     ${${objectName}_SRCS}
	     ./main.cpp
	     ./dab_tables.cpp
	     ./service-printer.cpp
	     ./tii-handling/tii-handler.cpp
             ./tii-handling/tiiQueue.cpp
             ./tii-handling/tii-reader.cpp
	     ../foonerd-dab/devices/device-handler.cpp
	     ../foonerd-dab/library/dab-api.cpp
	     ../foonerd-dab/library/src/dab-processor.cpp
	     ../foonerd-dab/library/src/time-converter.cpp
	     ../foonerd-dab/library/src/ofdm/ofdm-decoder.cpp
	     ../foonerd-dab/library/src/ofdm/phasereference.cpp
	     ../foonerd-dab/library/src/ofdm/phasetable.cpp
	     ../foonerd-dab/library/src/ofdm/freq-interleaver.cpp
	     ../foonerd-dab/library/src/ofdm/timesyncer.cpp
	     ../foonerd-dab/library/src/ofdm/sample-reader.cpp
	     ../foonerd-dab/library/src/ofdm/fic-handler.cpp
	     ../foonerd-dab/library/src/ofdm/ensemble.cpp
             ../foonerd-dab/library/src/ofdm/fib-config.cpp
             ../foonerd-dab/library/src/ofdm/fib-decoder.cpp
	     ../foonerd-dab/library/src/ofdm/tii-detector.cpp
	     ../foonerd-dab/library/src/backend/firecode-checker.cpp
	     ../foonerd-dab/library/src/backend/backend-base.cpp
	     ../foonerd-dab/library/src/backend/galois.cpp
	     ../foonerd-dab/library/src/backend/reed-solomon.cpp
	     ../foonerd-dab/library/src/backend/msc-handler.cpp
	     ../foonerd-dab/library/src/backend/virtual-backend.cpp
	     ../foonerd-dab/library/src/backend/audio-backend.cpp
	     ../foonerd-dab/library/src/backend/data-backend.cpp
	     ../foonerd-dab/library/src/backend/audio/mp4processor.cpp 
	     ../foonerd-dab/library/src/backend/audio/mp2processor.cpp 
	     ../foonerd-dab/library/src/backend/data/virtual-datahandler.cpp 
	     ../foonerd-dab/library/src/backend/data/tdc-datahandler.cpp 
	     ../foonerd-dab/library/src/backend/data/pad-handler.cpp 
	     ../foonerd-dab/library/src/backend/data/data-processor.cpp
	     ../foonerd-dab/library/src/backend/data/mot/mot-handler.cpp 
	     ../foonerd-dab/library/src/backend/data/mot/mot-dir.cpp 
	     ../foonerd-dab/library/src/backend/data/mot/mot-object.cpp
	     ../foonerd-dab/library/src/support/band-handler.cpp
	     ../foonerd-dab/library/src/support/charsets.cpp
#	     ../library/src/support/viterbi-handler.cpp
	     ../foonerd-dab/library/src/support/protTables.cpp
	     ../foonerd-dab/library/src/support/protection.cpp
	     ../foonerd-dab/library/src/support/eep-protection.cpp
	     ../foonerd-dab/library/src/support/uep-protection.cpp
	     ../foonerd-dab/library/src/support/fft-handler.cpp
	     ../foonerd-dab/library/src/support/dab-params.cpp
	     ../foonerd-dab/library/src/support/tii_table.cpp
	     ../foonerd-dab/library/src/support/viterbi-spiral/viterbi-spiral.cpp
	)

	if (X64_DEFINED)
           set (${objectName}_SRCS
                ${${objectName}_SRCS}
              ../foonerd-dab/library/src/support/viterbi-spiral/spiral-sse.c
           )
           set (${objectName}_HDRS
                ${${objectName}_HDRS}
             ../foonerd-dab/library/src/support/viterbi-spiral/spiral-sse.h
           )
           add_definitions (-DSSE_AVAILABLE)
        elseif (RPI_DEFINED)
           set (${objectName}_SRCS
                ${${objectName}_SRCS}
              ../foonerd-dab/library/src/support/viterbi-spiral/spiral-neon.c
           )
           set (${objectName}_HDRS
                ${${objectName}_HDRS}
             ../foonerd-dab/library/src/support/viterbi-spiral/spiral-neon.h
           )
           add_definitions (-DNEON_AVAILABLE)
	# compiler options moved below add_executable .. and target specific
	#set (CMAKE_CXX_FLAGS "${CMAKE_XCC_FLAGS} -mcpu=cortex-a7 -mfloat-abi=hard -mfpu=neon-vfpv4")
	#set (CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -mcpu=cortex-a7 -mfloat-abi=hard -mfpu=neon-vfpv4")
        else (X64_DEFINED)
           set (${objectName}_SRCS
                ${${objectName}_SRCS}
              ../foonerd-dab/library/src/support/viterbi-spiral/spiral-no-sse.c
           )
           set (${objectName}_HDRS
                ${${objectName}_HDRS}
             ../foonerd-dab/library/src/support/viterbi-spiral/spiral-no-sse.h
           )
        endif (X64_DEFINED)

	include_directories (
	          ${FFTW_INCLUDE_DIRS}
	          ${PORTAUDIO_INCLUDE_DIRS}
	          ${FAAD_INCLUDE_DIRS}
	          ${SNDFILES_INCLUDE_DIRS}
	)

#####################################################################

	add_executable (${objectName} 
	                ${${objectName}_SRCS}
	)

	if (RPI_DEFINED)
           # compiler options seem changed with gcc versions. gcc 8.3.0 on Raspbian didn't accept -mcpu ..
           # test options with "make VERBOSE=1"
           target_compile_options(${objectName}  PRIVATE -march=armv7-a -mfloat-abi=hard -mfpu=neon-vfpv4 )
        endif()

	target_link_libraries (${objectName}
	                       ${FFTW3F_LIBRARIES}
	                       ${extraLibs}
	                       ${FAAD_LIBRARIES}
	                       ${CMAKE_DL_LIBS}
	)

	INSTALL (TARGETS ${objectName} DESTINATION .)

########################################################################
# Create uninstall target
########################################################################

configure_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/cmake/cmake_uninstall.cmake.in"
    "${CMAKE_CURRENT_BINARY_DIR}/cmake_uninstall.cmake"
    IMMEDIATE @ONLY)

add_custom_target(uninstall
    COMMAND ${CMAKE_COMMAND} -P ${CMAKE_CURRENT_BINARY_DIR}/cmake_uninstall.cmake)
